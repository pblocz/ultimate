import { describe, expect, it, vi } from 'vitest'
import { ActionError, createApi } from '../../web/src/sdk/api.ts'
import { createStore } from '../../web/src/sdk/store.ts'
import { actionRef } from '../../shared/extension-api.ts'

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    respond(input as string, init!),
  )
  const store = createStore()
  const api = createApi(store, { fetch })
  return { api, fetch, store }
}
const ref = (extension: string, name: string) => actionRef<unknown, unknown>(extension, name)
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('conversation target', () => {
  it('keeps the selected chat after submit and restores it without selecting a primary agent', async () => {
    const first = setup(() => json(202, { submissionId: 19 }))
    first.store.show(42)
    await first.api.submit('First chat')
    expect(first.fetch.mock.calls[0][0]).toBe('/api/conversations/42/submit')
    expect(first.store.getState().requested).toBe(42)

    const restored = setup(() => json(202, { submissionId: 20 }))
    restored.store.show(first.store.getState().requested)
    await restored.api.submit('After reload')
    expect(restored.fetch.mock.calls[0][0]).toBe('/api/conversations/42/submit')
    expect(restored.store.getState().requested).toBe(42)
    first.store.stop()
    restored.store.stop()
  })

  it('uses an explicit target without changing the selected chat', async () => {
    const { api, fetch, store } = setup(() => json(202, { submissionId: 21 }))
    store.show(42)
    await api.submit('Scoped chat', 'followUp', 77)
    expect(fetch.mock.calls[0][0]).toBe('/api/conversations/77/submit')
    expect(store.getState().requested).toBe(42)
    store.stop()
  })

  it('refuses chat writes without a selection instead of targeting the storage root', async () => {
    const { api, fetch } = setup(() => json(200, { ok: true }))
    await expect(Promise.resolve().then(() => api.submit('No selected chat'))).rejects.toThrow(
      'Select a conversation',
    )
    await expect(
      Promise.resolve().then(() => api.configure({ thinkingLevel: 'high' })),
    ).rejects.toThrow('Select a conversation')
    await expect(Promise.resolve().then(() => api.abort())).rejects.toThrow('Select a conversation')
    await expect(Promise.resolve().then(() => api.compact())).rejects.toThrow(
      'Select a conversation',
    )
    await expect(Promise.resolve().then(() => api.cancelSubmission(19))).rejects.toThrow(
      'Select a conversation',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends persona and preset selections with creation and configuration', async () => {
    const { api, fetch, store } = setup((url) =>
      url === '/api/conversations' ? json(201, { id: 51 }) : json(200, { ok: true }),
    )
    expect(await api.createConversation({ definition: 'helper', preset: 'quick' })).toEqual({
      id: 51,
    })
    await api.configure({ definition: null }, 51)
    await api.configure({ preset: 'deliberate' }, 51)
    expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init?.body as string)])).toEqual([
      ['/api/conversations', { definition: 'helper', preset: 'quick' }],
      ['/api/conversations/51/configure', { definition: null }],
      ['/api/conversations/51/configure', { preset: 'deliberate' }],
    ])
    store.stop()
  })
})

describe('extension actions', () => {
  it('posts args for the shown conversation and resolves with the result', async () => {
    const { api, fetch } = setup(() => json(200, { result: { notes: [1, 2] } }))
    expect(await api.action(ref('notes', 'list notes'), { folder: 'drafts' })).toEqual({
      notes: [1, 2],
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/extensions/notes/actions/list%20notes')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      args: { folder: 'drafts' },
      conversationId: 1,
    })
    await api.action(ref('notes', 'list'), null, { conversationId: 7 })
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      args: null,
      conversationId: 7,
    })
  })

  it('rejects with an ActionError naming the extension, action, status, and message', async () => {
    const { api } = setup(() => json(500, { error: 'Extension action failed' }))
    const error = await api.action(ref('notes', 'save'), 'x').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ActionError)
    expect(error).toMatchObject({
      extension: 'notes',
      action: 'save',
      status: 500,
      message: 'Extension action failed',
    })
    const missing = setup(() => json(404, { error: 'Unknown extension action' }))
    await expect(missing.api.action(ref('notes', 'nope'))).rejects.toMatchObject({ status: 404 })
  })

  it('fails a 503 like any other server error', async () => {
    const unavailable = setup(() => json(503, { error: 'Service unavailable' }))
    await expect(unavailable.api.action(ref('onboarding', 'status'))).rejects.toBeInstanceOf(
      ActionError,
    )
    await expect(unavailable.api.updateUi({ set: {} })).rejects.toMatchObject({ status: 503 })
  })

  it('passes an abort through as an abort, not an action failure', async () => {
    const controller = new AbortController()
    const { api } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    )
    const pending = api.action(ref('notes', 'slow'), null, { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(ActionError)
    expect((error as Error).name).toBe('AbortError')
  })
})

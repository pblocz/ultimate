import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ConversationId } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import type { Delivered } from './fake-channel.ts'
import { held, prepareFauxServer, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof prepareFauxServer>>
type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; code: string }

const adapter = resolve('test/fake-channel.ts')
/** A facet that runs the fake adapter over `host.channelHost()` alone; `fail` makes its listener start fail. */
const fakeFacet = (
  name: string,
  fail = false,
) => `import { defineExtension } from '@earendil-works/pi-durable'
import { fakeChannel } from ${JSON.stringify(adapter)}
let port, channel
const state = { openReads: -1, earlyCode: '', readyRuns: 0 }
const listeners = new Map()
export default host => {
  port = host.channelHost()
  channel = fakeChannel(port, '${name}')
  host.onOpen(async () => {
    state.openReads = (await port.conversations.list()).length
    try { await channel.receive({ chatId: 'early', messageId: '0', text: 'too early' }) }
    catch (error) { state.earlyCode = error.code }
  })
  host.onReady(async () => {
    ${fail ? "throw new Error('fake listener failed')" : ''}
    state.readyRuns++
    await channel.recoverAll()
  })
  return defineExtension({ name: '${name}' })
}
const result = async (work) => {
  try { return { ok: true, value: (await work()) ?? null } }
  catch (error) { return { ok: false, code: error.code ?? String(error) } }
}
export const actions = {
  state: async () => ({ ...state }),
  receive: async (message) => result(() => channel.receive(message)),
  recover: async ({ chatId }) => result(() => channel.recover(chatId)),
  delivered: async () => channel.delivered,
  binding: async ({ chatId }) => channel.bindings.get(chatId) ?? null,
  listen: async ({ chatId }) => {
    const controller = new AbortController()
    listeners.set(chatId, controller)
    channel.listen(chatId, controller.signal).catch(() => {})
    return true
  },
  unlisten: async ({ chatId }) => { listeners.get(chatId)?.abort(); listeners.delete(chatId); return true },
  op: async ({ path, args }) => result(() => {
    const [group, name] = path.split('.')
    return port[group][name](...args)
  }),
}
`

async function fixture() {
  const home = await temp('ultimate-fake-channel-')
  const projectRoot = join(home, 'project')
  for (const [name, fail] of [
    ['fake-chat', false],
    ['fake-broken', true],
  ] as const) {
    const folder = join(projectRoot, '.ultimate/extensions', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'server.ts'), fakeFacet(name, fail))
  }
  const server = await prepareFauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  return { projectRoot, server }
}

const call = <T>(server: Server, action: string, args: unknown = {}, name = 'fake-chat') =>
  server.extensions.invoke(name, action, args as never, new AbortController().signal) as Promise<T>
const value = <T>(outcome: Outcome<T>) => {
  if (!outcome.ok) throw new Error(`Channel call failed: ${outcome.code}`)
  return outcome.value
}
const op = async <T>(server: Server, path: string, ...args: unknown[]) =>
  value(await call<Outcome<T>>(server, 'op', { path, args }))
const delivered = async (server: Server, chatId: string) =>
  (await call<Delivered[]>(server, 'delivered'))
    .filter((item) => item.chatId === chatId)
    .map((item) => item.text)
const binding = (server: Server, chatId: string) =>
  call<ConversationId>(server, 'binding', { chatId })
/** Answers the latest user text, so each chat's answer names its own input whatever else calls the model. */
const echo: FauxResponseFactory = (request) => {
  const content = request.messages.findLast((message) => message.role === 'user')?.content
  const text =
    typeof content === 'string'
      ? content
      : (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  return fauxAssistantMessage(`Answer: ${text}`)
}
type Opened = Awaited<ReturnType<Server['go']>>
/** Commit output to `id` the way background work does: an entry, with no model call or browser request. */
const append = (
  opened: Opened,
  id: ConversationId,
  kind: string,
  content: Parameters<typeof fauxAssistantMessage>[0],
) =>
  opened.harness.commit(
    (tx) =>
      tx.appendEntry(id, {
        kind,
        ...(kind === 'pi.assistant'
          ? { model: [fauxAssistantMessage(content)] }
          : { data: { secret: 'secret extension data' } }),
      }),
    context,
  )

it('serves separate chats through a ChannelHost-only adapter, from readiness through reconnect and reopen', async () => {
  expect(await readFile(adapter, 'utf8')).not.toMatch(
    /from '(@earendil-works\/(pi-durable|chord|pi-ai)|\.\.\/server|\.\.\/web)/,
  )
  const { projectRoot, server } = await fixture()
  try {
    expect(await call(server, 'receive', { chatId: 'alice', messageId: '1', text: 'x' })).toEqual({
      ok: false,
      code: 'unavailable',
    })
    const opened = await server.go()
    expect(await call(server, 'state')).toEqual({
      openReads: 1,
      earlyCode: 'unavailable',
      readyRuns: 1,
    })
    expect(await binding(server, 'early')).toBeNull()
    // The other channel's listener failed; this one is served, and the failure stays an operator diagnostic.
    await until(async () =>
      (await server.extensions.info.diagnostics()).includes(
        'Extension onReady failed: Error: fake listener failed',
      ),
    )

    server.host.faux!.setResponses(Array.from({ length: 8 }, () => echo))
    const first = value(
      await call<Outcome<{ submissionId: number }>>(server, 'receive', {
        chatId: 'alice',
        messageId: '1',
        text: 'hello A',
        senderId: 'alice-user',
      }),
    )
    await opened.harness.waitForIdle(context)
    // A platform redelivery of the same message is the same admission.
    expect(
      value(await call(server, 'receive', { chatId: 'alice', messageId: '1', text: 'hello A' })),
    ).toEqual(first)
    value(await call(server, 'receive', { chatId: 'bob', messageId: '1', text: 'hello B' }))
    await opened.harness.waitForIdle(context)
    value(await call(server, 'recover', { chatId: 'alice' }))
    value(await call(server, 'recover', { chatId: 'bob' }))
    expect(await delivered(server, 'alice')).toEqual(['Answer: hello A'])
    expect(await delivered(server, 'bob')).toEqual(['Answer: hello B'])

    const alice = await binding(server, 'alice')
    const bob = await binding(server, 'bob')
    expect(alice).not.toBe(bob)
    expect(await op(server, 'conversations.submission', alice, first.submissionId)).toMatchObject({
      status: 'answered',
    })
    // Separate histories over one Git-free workspace.
    const details = await Promise.all(
      [alice, bob].map((id) => op<{ summary: { cwd: string } }>(server, 'conversations.get', id)),
    )
    expect(details.map((detail) => detail.summary.cwd)).toEqual([projectRoot, projectRoot])
    expect(existsSync(join(projectRoot, '.git'))).toBe(false)
    const texts = async (id: ConversationId) =>
      JSON.stringify(await op(server, 'conversations.history', id, { direction: 'older' }))
    expect(await texts(alice)).toContain('hello A')
    expect(await texts(alice)).not.toContain('hello B')

    // Background output reaches a listening chat; internal context does not.
    await call(server, 'listen', { chatId: 'alice' })
    await append(opened, alice, 'pi.assistant', [
      fauxThinking('secret reasoning'),
      fauxText('Background note'),
      fauxToolCall('read', { path: 'secret-arguments' }),
    ])
    await append(opened, alice, 'extension.private', '')
    await until(async () => (await delivered(server, 'alice')).includes('Background note'))
    expect(JSON.stringify(await call(server, 'delivered'))).not.toMatch(
      /secret|fake listener failed/,
    )
    expect(await texts(alice)).not.toContain('secret')

    // Output committed while disconnected is sent on reconnect, from history.
    await call(server, 'unlisten', { chatId: 'alice' })
    await append(opened, alice, 'pi.assistant', 'Missed while away')
    await call(server, 'listen', { chatId: 'alice' })
    await until(async () => (await delivered(server, 'alice')).includes('Missed while away'))
    await call(server, 'unlisten', { chatId: 'alice' })
    expect(await delivered(server, 'alice')).toEqual([
      'Answer: hello A',
      'Background note',
      'Missed while away',
    ])

    // Output committed before the listener starts again is sent once it is ready.
    await append(opened, bob, 'pi.assistant', 'Before reopen')
    await server.release()
    await server.go()
    await until(async () => (await delivered(server, 'bob')).includes('Before reopen'))
    expect(await delivered(server, 'bob')).toEqual(['Answer: hello B', 'Before reopen'])
    expect(await call(server, 'state')).toMatchObject({ readyRuns: 2 })
  } finally {
    await server.close()
  }
})

it('drives models, queued input, cancellation, stop, and compaction through ChannelHost alone', async () => {
  const { server } = await fixture()
  try {
    const opened = await server.go()
    Object.assign(server.host.faux!.models[0], {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    })
    const models = await op<
      { provider: string; id: string; available: boolean; thinkingLevels: string[] }[]
    >(server, 'models.list')
    expect(models).toContainEqual(
      expect.objectContaining({ provider: 'faux', id: 'faux-1', available: true }),
    )
    expect(JSON.stringify(models)).not.toMatch(/apiKey|baseUrl/)

    server.host.faux!.setResponses([held])
    const started = value(
      await call<Outcome<{ conversationId: ConversationId; submissionId: number }>>(
        server,
        'receive',
        {
          chatId: 'ops',
          messageId: '1',
          text: 'start',
        },
      ),
    )
    const id = started.conversationId
    await until(async () => !!(await opened.harness.snapshot(LiveDoc, id, context))?.run)
    expect(
      await op(server, 'conversations.configure', id, {
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'high',
      }),
    ).toEqual({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' })

    const queued = value(
      await call<Outcome<{ submissionId: number }>>(server, 'receive', {
        chatId: 'ops',
        messageId: '2',
        text: 'withdraw me',
      }),
    )
    expect(await op(server, 'conversations.submission', id, queued.submissionId)).toEqual({
      status: 'queued',
    })
    await op(server, 'conversations.cancelQueuedInput', id, queued.submissionId)
    expect(await op(server, 'conversations.submission', id, queued.submissionId)).toEqual({
      status: 'unanswered',
      reason: 'aborted',
    })
    const kept = value(
      await call<Outcome<{ submissionId: number }>>(server, 'receive', {
        chatId: 'ops',
        messageId: '3',
        text: 'keep me',
      }),
    )
    await op(server, 'conversations.stop', id)
    expect((await opened.harness.snapshot(LiveDoc, id, context))?.run).toBeUndefined()
    expect(await op(server, 'conversations.submission', id, kept.submissionId)).toEqual({
      status: 'queued',
    })
    await op(server, 'conversations.cancelQueuedInput', id, kept.submissionId)

    server.host.faux!.setResponses([fauxAssistantMessage('Compacted summary')])
    const compacted = await op<{ operationId: string }>(server, 'conversations.compact', id, {})
    expect(compacted.operationId).toEqual(expect.any(String))
    await opened.harness.waitForIdle(context)
    expect(
      JSON.stringify(await op(server, 'conversations.history', id, { direction: 'older' })),
    ).not.toContain('Compacted summary')
  } finally {
    await server.close()
  }
})

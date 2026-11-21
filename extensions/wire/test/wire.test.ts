import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { UsageDoc } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { fauxServer, temp, until } from '../../../test/helpers.ts'
import { Summaries } from '../../conversations/summary.ts'
import { expect, it } from 'vitest'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'
import type { RelayExchange } from '@earendil-works/pi-claude-code/src/turn-relay.ts'
import { diffBodies } from '../diff.ts'
import { actions } from '../server.ts'
import { list, load, PER_CONVERSATION, save } from '../store.ts'

it.each([
  { mode: 'on', failure: undefined, payload: true, captures: 1 },
  {
    mode: 'on with provider error',
    failure: '400 Synthetic provider error',
    payload: true,
    captures: 1,
  },
  {
    mode: 'on with no payload',
    failure: 'Synthetic failure before payload',
    payload: false,
    captures: 1,
  },
  { mode: 'off', failure: undefined, payload: false, captures: 0 },
  { mode: 'write fails', failure: undefined, payload: true, captures: 0 },
])(
  'observes an automatic summary with Wire $mode',
  async ({ mode, failure, payload, captures }) => {
    const home = await temp('ultimate-wire-summary-')
    await mkdir(join(home, '.ultimate'))
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({
        summaryModel: 'faux/faux-summary',
        extensions: { enable: mode === 'off' ? [] : ['wire'] },
      }),
    )
    const state = join(home, 'state')
    const faux = fauxProvider({
      tokensPerSecond: 100000,
      models: [{ id: 'faux-1' }, { id: 'faux-summary' }],
    })
    const server = await fauxServer({
      ultimateRoot: resolvePath('.'),
      home: state,
      userHome: home,
      faux,
    })
    try {
      const { id } = await server.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        },
        context,
      )
      const conversation = (await server.harness.conversation(id, context))!
      await server.harness.commit(
        (tx) =>
          tx.appendEntry(id, {
            kind: 'pi.user',
            model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
          }),
        context,
      )
      if (mode === 'write fails') await writeFile(join(state, 'wire'), 'Not a directory')
      const response = { activity: 'Done.', title: 'Test summary capture', summary: 'Done.' }
      let attempts = 0
      let observed = false
      const respond: FauxResponseFactory = async (_request, options, _state, model) => {
        faux.appendResponses([respond])
        if (model.id !== 'faux-summary') {
          await options?.onPayload?.({ prompt: 'Synthetic chat payload' }, model)
          return fauxAssistantMessage('Done.')
        }
        attempts++
        observed = typeof options?.onPayload === 'function'
        if (payload) await options?.onPayload?.({ prompt: 'Synthetic summary payload' }, model)
        return failure
          ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: failure })
          : fauxAssistantMessage(JSON.stringify(response))
      }
      faux.setResponses([respond])
      const submission = await conversation.submit(
        { type: 'input', content: 'Test summary capture' },
        context,
      )
      expect((await submission.wait(context)).status).toBe('done')
      const read = () => server.harness.snapshot(Summaries, id, context)
      await until(async () => (await read())?.assessmentStatus === (failure ? 'error' : 'ready'))
      expect(attempts).toBe(1)
      expect(observed).toBe(mode !== 'off')
      expect((await read())?.activity).toBe(failure ? undefined : 'Done.')
      const usage = (await server.harness.snapshot(UsageDoc, id, context))?.models
      expect(usage?.['faux/faux-1']).toBeDefined()
      if (mode === 'write fails') return
      const summaries = async () =>
        (await list(state, id)).filter((call) => call.purpose === 'summary')
      await until(async () => (await summaries()).length === captures)
      const rows = await summaries()
      const records = await Promise.all(rows.map(({ n }) => load(state, id, n)))
      const expected = expect.objectContaining({
        conversationId: id,
        purpose: 'summary',
        request: payload ? '{"prompt":"Synthetic summary payload"}' : '',
        ...(failure && { failure }),
      })
      expect(records).toEqual(captures ? [expected] : [])
      const chats = (await list(state, id)).filter((call) => !call.purpose)
      const chatRecords = await Promise.all(chats.map(({ n }) => load(state, id, n)))
      const expectedChat = expect.objectContaining({
        request: '{"prompt":"Synthetic chat payload"}',
      })
      expect(chatRecords).toEqual(captures ? [expectedChat] : [])
      expect(await list(state, server.root.id)).toEqual([])
      const calls = server.extensions.trace.query()
      expect(calls.some((call) => call.name === 'conversations.summary-exchanges.record')).toBe(
        captures === 1,
      )
      expect(JSON.stringify(calls)).not.toContain('Synthetic summary payload')
      expect(JSON.stringify(calls)).not.toContain('Synthetic provider error')
    } finally {
      await server.close()
    }
  },
)

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/turn-relay.ts — the patched relay keeps each turn's exchange
// for useExchangeTap (Wire). Drop with the patch when upstream exposes the relay's exchanges.
it('keeps the relayed request as sent and the raw stream, never the credentials', async () => {
  const stream = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response
      .writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'a=b' })
      .end(stream)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn(undefined, (body) => Buffer.from(body.toString().replace('1', '2')), ['beta-x'])
  const exchanges: RelayExchange[] = []
  relay.onExchange = (exchange) => exchanges.push(exchange)
  try {
    const response = await fetch(`${url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'x-api-key': 'k', 'anthropic-beta': 'a' },
      body: '{"turn":1}',
    })
    await response.text()
    await relay.settled()
    const [exchange] = exchanges
    expect(exchange.requestBody.toString()).toBe('{"turn":2}')
    expect(exchange.response.toString()).toBe(stream)
    expect(exchange.url).toMatch(/\/v1\/messages\?beta=true$/)
    expect(exchange.requestHeaders).toMatchObject({
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      'anthropic-beta': 'a,beta-x',
    })
    expect(exchange.responseHeaders['set-cookie']).toBe('[redacted]')
    expect(JSON.stringify(exchange)).not.toMatch(/secret|"k"/)
  } finally {
    await relay.close()
    upstream.close()
  }
})

// Review of #540587: the exchange was read when the turn ended, before an aborted request's handler had recorded it.
it('hands over an aborted request once its handler ends', async () => {
  let reached: () => void
  const started = new Promise<void>((resolve) => (reached = resolve))
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.writeHead(200, { 'content-type': 'text/event-stream' }).write('event: ping\n\n')
    reached()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn()
  const exchanges: RelayExchange[] = []
  relay.onExchange = (exchange) => exchanges.push(exchange)
  try {
    const response = fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' }).catch(
      () => undefined, // The abort below cuts the connection; only the relay's record matters here.
    )
    await started
    relay.abort()
    await response
    await relay.settled()
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].requestBody.toString()).toBe('{}')
    expect(exchanges[0].failure).toMatch(/aborted/)
  } finally {
    await relay.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})

it('points at the first change in cache order, not JSON order', () => {
  // Anthropic caches tools, system, then messages; the body lists messages first.
  const previous = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: [{ type: 'text', text: 'You are helpful.' }],
    tools: [{ name: 'read' }],
    max_tokens: 100,
  }
  const appended = {
    ...previous,
    messages: [
      ...previous.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  }
  const append = diffBodies(previous, appended, 1)
  expect(append.firstChange).toBeUndefined()
  expect(append.added.map((segment) => segment.path)).toEqual([
    'messages[1]',
    'messages[1].content[0]',
  ])

  const changed = diffBodies(
    appended,
    { ...appended, system: [{ type: 'text', text: 'You are terse.' }] },
    2,
  )
  expect(changed.same).toBe(1)
  expect(changed.firstChange).toMatchObject({
    path: 'system[0]',
    before: expect.stringMatching(/^helpful/),
  })
})

it('compares two chat payloads with a summary between them', async () => {
  const queue = { tail: Promise.resolve() as Promise<unknown> }
  const home = await temp('ultimate-wire-diff-')
  const chat = {
    conversationId: 7,
    source: 'payload' as const,
    provider: 'test',
    model: 'test',
    api: 'test-api',
    startedAt: 1,
    endedAt: 2,
  }
  const first = await save(queue, home, { ...chat, request: '{"messages":["first"]}' })
  const summary = await save(queue, home, {
    ...chat,
    purpose: 'summary',
    request: '{"messages":["summary"]}',
  })
  const last = await save(queue, home, { ...chat, request: '{"messages":["first","next"]}' })
  const ctx = { host: { home }, conversationId: chat.conversationId } as Parameters<
    typeof actions.diff
  >[1]
  expect(await actions.diff({ n: last }, ctx)).toMatchObject({ previous: first, same: 1 })
  expect(await actions.diff({ n: summary }, ctx)).toBeNull()
})

it('keeps the newest calls of a conversation', async () => {
  const queue = { tail: Promise.resolve() as Promise<unknown> }
  const home = await mkdtemp(join(tmpdir(), 'wire-'))
  try {
    const call = {
      conversationId: 7,
      source: 'payload' as const,
      provider: 'p',
      model: 'm',
      startedAt: 0,
      endedAt: 1,
      request: '{}',
    }
    for (let i = 0; i < PER_CONVERSATION + 2; i++) await save(queue, home, call)
    const kept = await list(home, 7)
    expect(kept.map((summary) => summary.n)).toEqual(
      Array.from({ length: PER_CONVERSATION }, (_, i) => i + 3),
    )
    expect((await load(home, 7, 3))?.request).toBe('{}')
    expect(await readdir(join(home, 'wire', '7'))).toHaveLength(PER_CONVERSATION * 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

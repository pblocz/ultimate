import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Models } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { groqProvider } from '@earendil-works/pi-ai/providers/groq'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  ProviderDoc,
} from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { Summaries, summaryBehavior } from '../../extensions/conversations/summary.ts'
import { context } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { temp, until } from '../helpers.ts'

it.each([
  {
    name: 'a provider that requires a session header',
    create: opencodeGoProvider,
    sessionHeader: true,
    threaded: false,
  },
  {
    name: 'a provider without that header',
    create: groqProvider,
    sessionHeader: false,
    threaded: false,
  },
  {
    name: 'a provider with chat continuation',
    create: anthropicProvider,
    sessionHeader: false,
    threaded: true,
  },
])('routes automatic summaries with $name', async ({ create, sessionHeader, threaded }) => {
  const provider = create()
  const models = createModels()
  models.setProvider(provider)
  const api = threaded ? 'anthropic-messages' : 'openai-completions'
  const available = models.getModels(provider.id).filter((model) => model.api === api)
  const model = available[0]
  if (!model) throw new Error(`The fixture provider has no ${api} model`)
  const project = { summaryModel: `${model.provider}/${model.id}:off` }
  type Thread = { type: 'create' } | { type: 'continue'; previous_message_id: string }
  const calls: {
    kind: string
    session: string | string[] | undefined
    status: number
    thread?: Thread
  }[] = []
  const endpoint = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += String(chunk)
    const request = JSON.parse(text) as {
      model: string
      messages: unknown
      system?: unknown
      thread?: Thread
    }
    const isSummary = JSON.stringify(request.system ?? request.messages).includes(
      'Describe the latest final reply',
    )
    const session = req.headers['x-opencode-session']
    const status = sessionHeader && !session ? 400 : 200
    calls.push({ kind: isSummary ? 'summary' : 'chat', session, status, thread: request.thread })
    if (status === 400) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'MissingSessionID', message: 'MissingSessionID' } }))
      return
    }
    const content = isSummary
      ? JSON.stringify({ activity: 'Finished.', title: 'Test routing', summary: 'Finished.' })
      : 'Done.'
    if (threaded) {
      const usage = { input_tokens: 10, output_tokens: 4 }
      const events = [
        {
          type: 'message_start',
          message: { id: `local-${calls.length}`, model: request.model, usage },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: content } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      )
      return
    }
    const chunk = {
      id: 'local',
      object: 'chat.completion.chunk',
      created: 1,
      model: request.model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  })
  endpoint.listen(0, '127.0.0.1')
  await once(endpoint, 'listening')
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`
  // Replace only the endpoint and credential. The real provider adapter builds the request.
  const streamSimple: Models['streamSimple'] = (target, input, options) =>
    models.streamSimple(
      {
        ...target,
        baseUrl,
        ...(threaded && { compat: { ...target.compat, supportsMessageThreads: true } }),
      },
      input,
      { ...options, apiKey: 'local-test-key' },
    )
  const runtimeModels = new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return streamSimple
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const userHome = await temp('ultimate-routing-')
  const registry = createRegistry()
  let harness: Harness | undefined
  registry.install(
    defineExtension({
      name: 'conversations',
      ...summaryBehavior({
        harness: () => harness!,
        metadata: Metadata,
        userHome,
        projectSettings: async () => project,
        notice: () => {},
        modelRuntime: { getAvailableSnapshot: () => available },
      }),
    }),
  )
  try {
    const app = await Harness.open(
      new MemoryStorage(),
      { models: runtimeModels, registry },
      context,
    )
    harness = app
    const { id } = await app.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
      },
      context,
    )
    const conversation = (await app.conversation(id, context))!
    const session = (await app.snapshot(ProviderDoc, id, context))!.sessionId
    // Use an established conversation so this test sees one automatic reply summary.
    await app.commit(
      (tx) =>
        tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
    const read = () => app.snapshot(Summaries, id, context)
    const iterations = threaded
      ? ['Complete the test task.', 'Continue the test task.']
      : ['Complete the test task.']
    for (const input of iterations) {
      const before = (await read())?.lastAnswer
      const submission = await conversation.submit({ type: 'input', content: input }, context)
      expect((await submission.wait(context)).status).toBe('done')
      await until(async () => {
        const summary = await read()
        return (
          summary?.lastAnswer !== before &&
          ['ready', 'error'].includes(summary?.assessmentStatus ?? '')
        )
      })
    }
    const expectedSession = sessionHeader ? session : undefined
    const expected: typeof calls = [
      {
        kind: 'chat',
        session: expectedSession,
        status: 200,
        thread: threaded ? { type: 'create' } : undefined,
      },
      { kind: 'summary', session: expectedSession, status: 200 },
    ]
    if (threaded)
      expected.push(
        {
          kind: 'chat',
          session: undefined,
          status: 200,
          thread: { type: 'continue', previous_message_id: 'local-1' },
        },
        { kind: 'summary', session: undefined, status: 200 },
      )
    expect(calls).toEqual(expected)
    expect(await read()).toMatchObject({ assessmentStatus: 'ready', activity: 'Finished.' })
  } finally {
    try {
      await harness?.close(context)
    } finally {
      endpoint.closeAllConnections()
      await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    }
  }
})

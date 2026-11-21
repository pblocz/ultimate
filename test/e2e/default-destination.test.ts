import { createECDH, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeSecret } from '../../extensions/secrets/store.ts'
import { context } from '../../server/harness.ts'
import { defaultDestinationFixture } from '../default-destination-fixture.ts'
import { post } from '../helpers.ts'

let f: Awaited<ReturnType<typeof defaultDestinationFixture>>
beforeEach(async () => {
  f = await defaultDestinationFixture()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await f?.close()
})

const reply = (text = 'Done') => fauxAssistantMessage(text)
const failure = (errorMessage: string) =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage })
const providerFailure = () => failure('invalid model configuration')
const send = (id: ConversationId, text: string) =>
  post(f.server, `/api/conversations/${id}/submit`, { text })
const conversation = async (id: ConversationId) =>
  (await f.server.harness.conversation(id, context))!
const entries = async (id: ConversationId) =>
  (await (await conversation(id)).context(context)).entries
const kinds = async (id: ConversationId, kind: string) =>
  (await entries(id)).filter((entry) => entry.kind === kind)

it('watchdog reports an ownerless failure to the configured resident', async () => {
  const id = await f.chat()
  f.server.host.faux!.setResponses([providerFailure(), reply()])
  expect((await send(id, 'Fail in this chat')).status).toBe(202)
  await expect
    .poll(async () => (await kinds(f.neutral, 'watchdog.failure')).map((entry) => entry.data))
    .toEqual([
      expect.objectContaining({
        conversation: id,
        error: expect.stringContaining('invalid model configuration'),
      }),
    ])
})

it('automations discovers a project script with the configured resident as its recipient', async () => {
  const path = join(f.projectRoot, '.ultimate/automations/sample')
  await mkdir(path, { recursive: true })
  const manifest = { name: 'Sample', ask: 'Watch sample' }
  await writeFile(join(path, 'automation.json'), JSON.stringify(manifest))
  const listed = await f.action('automations.list')
  expect(listed.status).toBe(200)
  expect(listed.data.result).toEqual([
    expect.objectContaining({ id: 'sample', enabled: false, subscribers: ['@neutral'] }),
  ])
})

it('pause leaves a passive limit card for the configured resident', async () => {
  const id = await f.chat()
  f.server.host.faux!.setResponses([
    failure(
      "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: This request would exceed your account's rate limit. Please try again later.)",
    ),
    reply(),
  ])
  try {
    expect((await send(id, 'Reach the limit')).status).toBe(202)
    await expect
      .poll(async () => (await f.action('pause.state')).data.result?.limit?.conversationId)
      .toBe(id)
    await expect
      .poll(async () => (await kinds(f.neutral, 'pause.limit')).map((entry) => entry.data))
      .toEqual([expect.objectContaining({ conversationId: id })])
    expect(await kinds(f.neutral, 'pi.assistant')).toEqual([])
  } finally {
    await f.action('pause.play')
  }
})

it('push observes failed runs in the configured resident conversation', async () => {
  const endpoint = 'https://push.example.invalid/destination-test'
  const client = createECDH('prime256v1')
  client.generateKeys()
  const keys = {
    p256dh: client.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
  expect((await f.action('push.key')).status).toBe(200)
  expect(
    (await f.action('push.subscribe', { subscription: { endpoint, keys, origin: f.server.url } }))
      .status,
  ).toBe(200)
  const fetch = globalThis.fetch
  const push = vi.fn<() => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 201 })),
  )
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    input === endpoint ? push() : fetch(input, init),
  )
  f.server.host.faux!.setResponses([providerFailure()])
  expect((await send(f.neutral, 'Fail in the resident')).status).toBe(202)
  await expect.poll(() => push.mock.calls.length).toBe(1)
})

it('goal binds its start and reminder to the conversation that starts it', async () => {
  const id = await f.chat()
  f.server.host.faux!.setResponses([reply()])
  const start = await f.action('goal.start', { text: 'Finish the test' }, id)
  expect([start.status, start.data.error]).toEqual([200, undefined])
  await expect.poll(async () => (await kinds(id, 'goal.started')).length).toBe(1)
  await expect
    .poll(async () => (await f.action('automations.list')).data.result)
    .toEqual([expect.objectContaining({ schedule: expect.anything(), subscribers: [id] })])
  expect(await kinds(f.neutral, 'goal.started')).toEqual([])
})

it('todos gives the configured resident the list and permits it to update the list', async () => {
  const add = await f.action('todos.add', { text: 'Record the test', owner: 'ultimate' })
  expect([add.status, add.data.error]).toEqual([200, undefined])
  f.server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('todo', { action: 'done', id: 1 })], {
      stopReason: 'toolUse',
    }),
    reply(),
  ])
  expect((await send(f.neutral, 'Finish the todo')).status).toBe(202)
  await (await conversation(f.neutral)).waitForIdle(context)
  const history = await entries(f.neutral)
  expect(JSON.stringify(history)).toContain('Open to-dos (todo tool: done when finished)')
  expect(JSON.stringify(history)).toContain('Done 1')
})

it('keep-warm tracks the user input time of the configured resident', async () => {
  f.server.host.faux!.setResponses([reply()])
  expect((await send(f.neutral, 'Use the resident')).status).toBe(202)
  await expect
    .poll(async () => (await f.action('keep-warm.state')).data.result?.inputAt)
    .toBeTypeOf('number')
})

it('side-chat can fork the configured resident', async () => {
  f.server.host.faux!.setResponses([reply('Main answer'), reply('Side answer')])
  expect((await send(f.neutral, 'Use the resident')).status).toBe(202)
  await (await conversation(f.neutral)).waitForIdle(context)
  const opened = await f.action('side-chat.open', { text: 'A side question' }, f.neutral)
  expect([opened.status, opened.data.error]).toEqual([200, undefined])
  const side = opened.data.result.id as ConversationId
  expect(side).not.toBe(f.neutral)
  await expect.poll(async () => JSON.stringify(await entries(side))).toContain('Side answer')
})

it('voice-live briefs Voice from the configured resident', async () => {
  f.server.host.faux!.setResponses([reply('Recorded for the voice brief')])
  expect((await send(f.neutral, 'Test request for the voice brief')).status).toBe(202)
  await (await conversation(f.neutral)).waitForIdle(context)
  await writeSecret(f.home, 'OPENAI_API_KEY', 'sk-test-not-real')
  const fetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    input === 'https://api.openai.com/v1/live/sessions'
      ? Promise.resolve(
          Response.json({
            session: { id: 'test-voice' },
            transport: { type: 'webrtc', sdp: 'fake-answer' },
          }),
        )
      : fetch(input, init),
  )
  const voice = await f.action('voice-live.start', { sdp: 'fake-offer' })
  expect([voice.status, voice.data.error]).toEqual([200, undefined])
  await expect
    .poll(async () =>
      JSON.stringify(
        await kinds(voice.data.result.conversation as ConversationId, 'voice.context'),
      ),
    )
    .toContain('Test request for the voice brief')
})

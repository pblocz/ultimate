import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord/json'
import { InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'
import { ordinarySource } from '../ordinary-web-fixture.ts'
import type { Automation } from '../../extensions/automations/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
/** Listening TCP servers of this process. */
const listeners = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length

/** A channel with no listener: it reaches conversations only through `host.channelHost()`. */
const facet = `import { defineExtension } from '@earendil-works/pi-durable'
let port
export default (host) => {
  port = host.channelHost()
  return defineExtension({ name: 'local-chat' })
}
export const actions = {
  op: async ({ path, args }) => {
    const [group, name] = path.split('.')
    return (await port[group][name](...args)) ?? null
  },
}
`
const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content as { type: string; text?: string }[] | undefined) ?? [])
        .flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : []))
        .join('')

async function fixture() {
  const root = await temp('ultimate-local-delivery-')
  cleanup.push(() => removeTemp(root))
  const source = await ordinarySource(join(root, 'source'))
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user')
  await mkdir(join(workspace, '.ultimate/extensions/local-chat'), { recursive: true })
  await writeFile(join(workspace, '.ultimate/extensions/local-chat/server.ts'), facet)
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  // The web channel is off: nothing below may need a browser, a stream or a listener.
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { disable: ['web'] } }),
  )
  const options = {
    ultimateRoot: source,
    projectRoot: workspace,
    userHome,
    home: join(root, 'state'),
  }
  let gate = Promise.withResolvers<void>()
  let current: Awaited<ReturnType<typeof fauxServer>>
  /** Echoes the last user input; one that holds `HOLD` waits for the gate, or for its abort. */
  const respond: FauxResponseFactory = async (request, call) => {
    current.host.faux!.appendResponses([respond])
    const text = textOf(request.messages.findLast((message) => message.role === 'user')?.content)
    if (text.includes('HOLD'))
      await Promise.race([
        gate.promise,
        new Promise((_resolve, fail) =>
          call?.signal?.addEventListener('abort', () => fail(new Error('aborted'))),
        ),
      ])
    return fauxAssistantMessage(`Answer: ${text.slice(-60)}`)
  }
  const open = async () => {
    current = await fauxServer(options)
    current.host.faux!.setResponses([respond])
    return current
  }
  const before = listeners()
  await open()
  cleanup.push(() => current.close())
  const op = async <T>(path: string, ...args: unknown[]) =>
    (await current.extensions.invoke(
      'local-chat',
      'op',
      { path, args } as JsonValue,
      new AbortController().signal,
    )) as T
  const automations = (action: string, args: JsonValue) =>
    current.extensions.invoke('automations', action, args, new AbortController().signal)
  const entries = async (id: ConversationId) =>
    (await (await current.harness.conversation(id, context))!.context(context)).entries
  const answers = async (id: ConversationId) =>
    (await entries(id))
      .filter((entry) => entry.kind === 'pi.assistant')
      .map((entry) => textOf((entry.model?.[0] as { content?: unknown } | undefined)?.content))
  const inputs = async (id: ConversationId, kind = 'pi.user') =>
    (await entries(id)).filter((entry) => entry.kind === kind)
  return {
    server: () => current,
    before,
    open,
    op,
    automations,
    entries,
    answers,
    inputs,
    gate: () => gate,
    newGate: () => (gate = Promise.withResolvers<void>()),
  }
}

it('keeps each answer in its conversation and delivers automation triggers with the web off', async () => {
  const f = await fixture()
  expect(f.server().url).toBeUndefined()
  expect(listeners()).toBe(f.before)
  const twelve = (await f.op<{ id: ConversationId }>('conversations.create', { title: 'twelve' }))
    .id
  const other = (await f.op<{ id: ConversationId }>('conversations.create', { title: 'other' })).id

  // An answer stays where its input went, whatever else the user opens meanwhile.
  await f.op('conversations.submit', twelve, { text: 'question for twelve', requestId: 'q1' })
  await f.op('conversations.submit', other, { text: 'HOLD other', requestId: 'busy' })
  await until(async () => (await f.answers(twelve)).includes('Answer: question for twelve'))
  await until(async () => !!(await f.server().harness.snapshot(LiveDoc, other, context))?.run)
  expect(JSON.stringify(await f.answers(other))).not.toContain('question for twelve')

  // Both subscribers get the trigger: the idle one starts a turn, the busy one queues a follow-up.
  const both = (await f.automations('create', {
    name: 'Both',
    schedule: 'every 1d',
    subscribers: [twelve, other],
  })) as Automation
  await f.automations('run', { id: both.id })
  await until(async () => (await f.inputs(twelve, 'automations.fired')).length === 1)
  await until(async () => (await f.answers(twelve)).length === 2)
  await until(
    async () =>
      ((await f.server().harness.snapshot(InboxDoc, other, context))?.items.length ?? 0) === 1,
  )
  expect(await f.inputs(other, 'automations.fired')).toHaveLength(0)
  f.gate().resolve()
  await until(async () => (await f.inputs(other, 'automations.fired')).length === 1)
  await until(async () => (await f.answers(other)).length === 2)
  expect((await f.inputs(twelve, 'automations.fired'))[0].data).toEqual({
    id: both.id,
    name: 'Both',
    text: '',
  })

  // A prompt-only run answers in its own conversation; no subscriber gets a copy.
  const solo = (await f.automations('create', {
    name: 'Solo',
    schedule: 'every 1d',
    prompt: 'Say solo',
  })) as Automation
  expect(solo.subscribers).toEqual([])
  await f.automations('run', { id: solo.id })
  const run = async () =>
    ((await f.automations('list', null)) as Automation[]).find((a) => a.id === solo.id)?.runs[0]
  await until(async () => (await run())?.conversationId !== undefined)
  const runConversation = (await run())!.conversationId as ConversationId
  await until(async () =>
    (await f.answers(runConversation)).some((text) => text.includes('Say solo')),
  )
  for (const id of [twelve, other]) {
    expect(JSON.stringify(await f.entries(id))).not.toContain('Say solo')
    expect(await f.answers(id)).toHaveLength(2)
  }
  expect(listeners()).toBe(f.before)
})

it('keeps a turn interrupted by a restart, answers it once, and admits its retry once', async () => {
  const f = await fixture()
  const twelve = (await f.op<{ id: ConversationId }>('conversations.create', { title: 'twelve' }))
    .id
  const submitted = await f.op<{ submissionId: number }>('conversations.submit', twelve, {
    text: 'HOLD across restart',
    requestId: 'restart-1',
  })
  await until(async () => !!(await f.server().harness.snapshot(LiveDoc, twelve, context))?.run)
  // The channel goes away mid-turn, and so does the process.
  await f.server().close()
  f.newGate().resolve()
  await f.open()
  expect(f.server().url).toBeUndefined()
  await until(async () => (await f.answers(twelve)).includes('Answer: HOLD across restart'))
  const retried = await f.op<{ submissionId: number }>('conversations.submit', twelve, {
    text: 'HOLD across restart',
    requestId: 'restart-1',
  })
  expect(retried.submissionId).toBe(submitted.submissionId)
  await f.server().harness.waitForIdle(context)
  expect(await f.inputs(twelve)).toHaveLength(1)
  expect(await f.answers(twelve)).toEqual(['Answer: HOLD across restart'])
  expect(listeners()).toBe(f.before)
})

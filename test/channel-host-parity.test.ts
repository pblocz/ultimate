import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ConversationId } from '@earendil-works/pi-durable'
import { InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { UserInputEvent } from '../shared/events.ts'
import { eventHost, fauxServer, held, post, removeTemp, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>

const homes: string[] = []
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})

/** A server whose `parity-probe` facet calls each channel operation with the arguments it is given. */
async function fixture() {
  const home = await temp('ultimate-channel-parity-')
  homes.push(home)
  const projectRoot = join(home, 'project')
  const folder = join(projectRoot, '.ultimate/extensions/parity-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
let port
export default host => {
  port = host.channelHost()
  return defineExtension({ name: 'parity-probe' })
}
const failure = async (work) => {
  try { return { ok: true, value: await work() } }
  catch (error) { return { ok: false, code: error.code } }
}
export const actions = {
  create: async (input) => failure(() => port.conversations.create(input)),
  submit: async ({ id, input }) => failure(() => port.conversations.submit(id, input)),
  configure: async ({ id, change }) => failure(() => port.conversations.configure(id, change)),
  stop: async ({ id }) => failure(() => port.conversations.stop(id)),
}
`,
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  return server
}

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string }
const direct = <T>(server: Server, action: string, args: unknown) =>
  server.extensions.invoke(
    'parity-probe',
    action,
    args as never,
    new AbortController().signal,
  ) as Promise<Outcome<T>>
const value = <T>(outcome: Outcome<T>) => {
  if (!outcome.ok) throw new Error(`Channel call failed: ${outcome.code}`)
  return outcome.value
}

it('creates, configures, and admits input with the same stored effects through the web and the channel', async () => {
  const server = await fixture()
  Object.assign(server.host.faux!.models[0], {
    reasoning: true,
    thinkingLevelMap: { minimal: null, medium: null },
  })
  const webCreated = await post(server, '/api/conversations', { title: 'Same title' })
  expect(webCreated.status).toBe(201)
  const webId = webCreated.data.id as ConversationId
  const channelId = value(
    await direct<{ id: ConversationId }>(server, 'create', { title: 'Same title' }),
  ).id
  expect(channelId).not.toBe(webId)
  const agent = async (id: ConversationId) => {
    const conversation = (await server.harness.conversation(id, context))!
    const { cwd, model, thinkingLevel } = await conversation.agent(context)
    return { cwd, model, thinkingLevel }
  }
  expect(await agent(channelId)).toEqual(await agent(webId))
  expect((await server.harness.snapshot(Metadata, channelId, context))?.title).toBe('Same title')
  expect((await server.harness.snapshot(Metadata, webId, context))?.title).toBe('Same title')

  const change = { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' }
  expect((await post(server, `/api/conversations/${webId}/configure`, change)).status).toBe(200)
  value(await direct(server, 'configure', { id: channelId, change }))
  expect((await agent(webId)).thinkingLevel).toBe('high')
  expect(await agent(channelId)).toEqual(await agent(webId))

  const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
  const input = { text: 'look at this', images: [image] }
  server.host.faux!.setResponses([fauxAssistantMessage('Seen.'), fauxAssistantMessage('Seen.')])
  // A browser cannot claim a channel source; the web keeps only its own device fields.
  const webSubmitted = await post(server, `/api/conversations/${webId}/submit`, {
    ...input,
    source: { channel: 'telegram', chatId: 'forged' },
  })
  expect(webSubmitted.status).toBe(202)
  const channelSubmitted = value(
    await direct<{ submissionId: number }>(server, 'submit', {
      id: channelId,
      input: { ...input, source: { channel: 'parity', chatId: 'chat-1' } },
    }),
  )
  await server.harness.waitForIdle(context)
  const stored = async (id: ConversationId) => {
    const conversation = (await server.harness.conversation(id, context))!
    const entries = (await conversation.entries({}, 100, undefined, context)).items
    return entries
      .filter((entry) => entry.kind === 'pi.user')
      .map((entry) => entry.model?.map((message) => ({ ...message, timestamp: 0 })))
  }
  expect(await stored(channelId)).toEqual(await stored(webId))
  expect(await stored(webId)).toHaveLength(1)

  const events = (
    await eventHost(() => server.harness, 'test').eventLog.recent({
      events: [UserInputEvent],
      order: 'ascending',
    })
  ).map((event) => event.data)
  const web = events.find((event) => event.conversation === webId)!
  const channel = events.find((event) => event.conversation === channelId)!
  // The source is the only intended difference: the web keeps its device fields and has no channel source.
  expect(web).not.toHaveProperty('source')
  expect(web.device).toEqual(expect.any(String))
  expect(channel.source).toEqual({ channel: 'parity', chatId: 'chat-1' })
  const shape = ({ kind, length, entry, submission }: typeof web) => ({
    kind,
    length,
    placed: entry !== undefined,
    queued: submission !== undefined,
  })
  expect(shape(channel)).toEqual(shape(web))
  expect(channelSubmitted.submissionId).not.toBe(webSubmitted.data.submissionId)
})

it('stops foreground work and keeps queued follow-ups through the web and the channel', async () => {
  const server = await fixture()
  const ids = [
    (await post(server, '/api/conversations', {})).data.id as ConversationId,
    value(await direct<{ id: ConversationId }>(server, 'create', {})).id,
  ]
  server.host.faux!.setResponses([held, held])
  for (const id of ids) {
    expect((await post(server, `/api/conversations/${id}/submit`, { text: 'start' })).status).toBe(
      202,
    )
    await until(async () => !!(await server.harness.snapshot(LiveDoc, id, context))?.run)
    expect(
      (
        await post(server, `/api/conversations/${id}/submit`, {
          text: 'after',
          whenBusy: 'followUp',
        })
      ).status,
    ).toBe(202)
  }
  expect((await post(server, `/api/conversations/${ids[0]}/abort`)).status).toBe(200)
  value(await direct(server, 'stop', { id: ids[1] }))
  for (const id of ids) {
    expect((await server.harness.snapshot(LiveDoc, id, context))?.run).toBeUndefined()
    expect(
      (await server.harness.snapshot(InboxDoc, id, context))?.items.map((item) =>
        item.mode !== 'write' ? item.content : undefined,
      ),
    ).toEqual(['after'])
  }
})

it('reports the same failures as the web statuses', async () => {
  const server = await fixture()
  const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
  const cases: [string, unknown, number, string][] = [
    ['/api/conversations/999/submit', { text: 'x' }, 404, 'not_found'],
    ['/api/conversations/1/submit', { text: 7 }, 400, 'invalid_input'],
    [
      '/api/conversations/1/submit',
      { text: '', images: [{ ...image, mimeType: 'image/svg+xml' }] },
      400,
      'invalid_input',
    ],
    [
      '/api/conversations/1/submit',
      { text: '', images: Array.from({ length: 5 }, () => image) },
      413,
      'invalid_input',
    ],
    ['/api/conversations/1/configure', { thinkingLevel: 'bogus' }, 400, 'invalid_input'],
  ]
  for (const [path, data, status, code] of cases) {
    expect((await post(server, path, data)).status).toBe(status)
    const id = Number(/\/conversations\/(\d+)\//.exec(path)![1])
    const outcome = path.endsWith('/submit')
      ? await direct(server, 'submit', { id, input: data })
      : await direct(server, 'configure', { id, change: data })
    expect(outcome).toEqual({ ok: false, code })
  }
})

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fauxServer, post, removeTemp, temp, until } from '@ultimate/test/helpers.ts'
import { ordinarySource } from '@ultimate/test/ordinary-web-fixture.ts'
import type { Automation } from '../../types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const channel = { kind: 'channel', channel: 'telegram', instanceId: 'test', address: 'chat-42' }

async function fixture() {
  const root = await temp('ultimate-automation-destinations-')
  cleanup.push(() => removeTemp(root))
  const source = await ordinarySource(join(root, 'source'))
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user')
  await mkdir(workspace)
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['watcher', 'neutral'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Destination test\nmodel: faux/faux-1\ntools: []\n${name === 'neutral' ? 'resident: true\n' : ''}---\nKeep answers short.\n`,
    )
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  const notices: string[] = []
  const options = {
    ultimateRoot: source,
    projectRoot: workspace,
    userHome,
    home: join(root, 'state'),
  }
  const app = await fauxServer(options)
  let current = app
  cleanup.push(() => current.close())
  /** Close and start the same instance again, as a restart does. */
  const reopen = async () => {
    await current.close()
    current = await fauxServer(options)
    return current
  }
  app.events.listeners.add((name, data) => {
    if (
      name === 'notice' &&
      data &&
      typeof data === 'object' &&
      'message' in data &&
      typeof data.message === 'string'
    )
      notices.push(data.message)
  })
  let calls = 0
  const respond: FauxResponseFactory = () => {
    calls++
    app.host.faux!.appendResponses([respond])
    return fauxAssistantMessage('Complete')
  }
  app.host.faux!.setResponses([respond])
  const invoke = (action: string, args: JsonValue = null, callerId?: ConversationId) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, callerId)
  const create = async (args: JsonValue, callerId?: ConversationId) =>
    (await invoke('create', args, callerId)) as Automation
  const list = async () => (await invoke('list')) as Automation[]
  const newChat = async () => {
    const created = await post(app, '/api/conversations')
    expect(created.status).toBe(201)
    return { id: created.data.id as ConversationId }
  }
  const caller = await newChat()
  const receiver = await newChat()
  const manifest = async (slug: string, value: object) => {
    const folder = join(workspace, '.ultimate/automations', slug)
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'automation.json')
    await writeFile(path, JSON.stringify({ name: slug, ask: 'Watch test', ...value }))
    return path
  }
  return {
    app,
    source,
    workspace,
    caller,
    receiver,
    create,
    invoke,
    list,
    manifest,
    notices,
    reopen,
    calls: () => calls,
  }
}

it.each(['number', 'id', 'name'])(
  'uses a %s conversation destination without a coordinator',
  async (kind) => {
    const f = await fixture()
    const address =
      kind === 'number' ? f.receiver.id : kind === 'id' ? `#${f.receiver.id}` : '@neutral'
    const a = await f.create(
      { name: 'Notify', schedule: 'in 1h', destination: { kind: 'conversation', address } },
      f.caller.id,
    )
    const target = a.subscribers[0]
    expect(a.subscribers).toHaveLength(1)
    expect(target).toBe(kind === 'name' ? '@neutral' : f.receiver.id)
    expect(f.calls()).toBe(0)
    await f.invoke('run', { id: a.id })
    await until(() => f.calls() === 1)
    expect((await f.list())[0].fires).toBe(1)
  },
)

it('rejects channel creation and update before any side effects', async () => {
  const f = await fixture()
  await expect(
    f.create({ name: 'Future', ask: 'Watch', scope: 'project', destination: channel }, f.caller.id),
  ).rejects.toThrow('Channel delivery is not supported')
  expect(await f.list()).toEqual([])
  expect(f.calls()).toBe(0)
  await expect(access(join(f.workspace, '.ultimate/automations/future'))).rejects.toThrow('ENOENT')
  const a = await f.create({ name: 'Keep', schedule: 'in 1h' }, f.caller.id)
  const before = JSON.stringify(await f.list())
  await expect(
    f.invoke('update', { id: a.id, name: 'Changed', destination: channel }),
  ).rejects.toThrow('Channel delivery is not supported')
  expect(JSON.stringify(await f.list())).toBe(before)
  expect(f.calls()).toBe(0)
})

it('rejects conflicting destination options before creation', async () => {
  const f = await fixture()
  await expect(
    f.create(
      {
        name: 'Conflict',
        schedule: 'in 1h',
        subscribers: [f.caller.id],
        destination: { kind: 'conversation', address: f.receiver.id },
      },
      f.caller.id,
    ),
  ).rejects.toThrow('destination cannot be combined')
  expect(await f.list()).toEqual([])
})

it('creates a project script from its caller without an ultimate definition', async () => {
  const f = await fixture()
  await f.manifest('other', {})
  const a = await f.create(
    { name: 'Caller script', ask: 'Watch test', scope: 'project' },
    f.caller.id,
  )
  expect(a.subscribers).toEqual([f.caller.id])
  expect(a.script?.conversationId).toBeTypeOf('number')
  const path = join(f.workspace, '.ultimate/automations/caller-script/automation.json')
  const before = await readFile(path, 'utf8')
  expect(before).not.toContain('@ultimate')
  expect((await f.list()).map((item) => item.script?.conversationId)).toEqual([
    a.script?.conversationId,
  ])
  expect(await readFile(path, 'utf8')).toBe(before)
  // The caller binds only the script that this request created.
  expect((await f.list()).map((item) => item.id)).toEqual(['caller-script'])
})

it('adopts an unbound project file that an interrupted create published', async () => {
  const f = await fixture()
  const path = await f.manifest('adopt', { once: true })
  const before = await readFile(path, 'utf8')
  expect(await f.list()).toEqual([])
  const a = await f.create({ name: 'adopt', ask: 'Watch test', scope: 'project' }, f.caller.id)
  expect(a).toMatchObject({ id: 'adopt', subscribers: [f.caller.id] })
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('keeps a project record when its file names an unsupported channel', async () => {
  const f = await fixture()
  const path = await f.manifest('kept', {
    destination: { kind: 'conversation', address: '@neutral' },
  })
  const [found] = await f.list()
  await writeFile(path, JSON.stringify({ name: 'kept', ask: 'Watch test', destination: channel }))
  expect(await f.list()).toEqual([found])
  expect(
    f.notices.some(
      (message) =>
        message.includes('kept') && message.includes('Channel delivery is not supported'),
    ),
  ).toBe(true)
  await expect(f.invoke('run', { id: 'kept' })).rejects.toThrow('Channel delivery is not supported')
  expect(f.calls()).toBe(0)
})

it('discovers an explicit project recipient without a coordinator and reports a missing destination', async () => {
  const f = await fixture()
  await f.manifest('explicit', { destination: { kind: 'conversation', address: '@neutral' } })
  const found = await f.list()
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({ id: 'explicit', enabled: false, subscribers: ['@neutral'] })
  expect(f.calls()).toBe(0)
  await f.manifest('unbound', {})
  expect((await f.list()).map((a) => a.id)).toEqual(['explicit'])
  expect(
    f.notices.some((message) => message.includes('unbound') && message.includes('destination')),
  ).toBe(true)
  expect(f.calls()).toBe(0)
})

it('keeps a broken project file record and rewrites the file on update, as before', async () => {
  const f = await fixture()
  const path = await f.manifest('broken', {
    destination: { kind: 'conversation', address: '@neutral' },
  })
  expect(await f.list()).toMatchObject([{ id: 'broken', subscribers: ['@neutral'] }])
  await writeFile(path, '{not json')
  expect(await f.list()).toMatchObject([{ id: 'broken', subscribers: ['@neutral'] }])
  expect(f.notices.some((message) => message.includes('broken'))).toBe(true)
  await f.invoke('update', { id: 'broken', name: 'Fixed' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    name: 'Fixed',
    ask: 'Watch test',
    once: true,
    to: '@neutral',
  })
  expect(await f.list()).toMatchObject([{ id: 'broken', name: 'Fixed', subscribers: ['@neutral'] }])
  expect(f.calls()).toBe(0)
})

it('keeps a caller-bound project file target across restart without a coordinator', async () => {
  const f = await fixture()
  const a = await f.create({ name: 'Restart', ask: 'Watch test', scope: 'project' }, f.caller.id)
  const path = join(f.workspace, '.ultimate/automations/restart/automation.json')
  const before = await readFile(path, 'utf8')
  const next = await f.reopen()
  const listed = (await next.extensions.invoke(
    'automations',
    'list',
    null,
    new AbortController().signal,
  )) as Automation[]
  expect(listed).toMatchObject([
    {
      id: 'restart',
      subscribers: [f.caller.id],
      script: { conversationId: a.script?.conversationId },
    },
  ])
  expect(listed[0].script?.to).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe(before)
})

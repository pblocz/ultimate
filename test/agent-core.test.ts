import { access, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ChannelHost } from '../shared/channel-host.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { FIRST_CHAPTER, finishChapterSwitch, requestChapter } from '../lib/chapters.ts'
import { context } from '../server/harness.ts'
import type { Automation } from '../extensions/automations/types.ts'
import { pendingAgentCore, recoveredAgentCore, recoveryModel } from './agent-core-recovery.ts'
import { discoverAgents } from '../lib/agents.ts'
import { agentCoreExtensions, agentCoreFixture } from './agent-core-fixture.ts'
import { until } from './until.ts'

const fixtures: Awaited<ReturnType<typeof agentCoreFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
        .join('')
const latestUser = (request: Parameters<FauxResponseFactory>[0]) =>
  textOf(request.messages.findLast((message) => message.role === 'user')?.content)
const answer = (request: Parameters<FauxResponseFactory>[0]) => {
  const user = latestUser(request)
  // Pi can add a system state message after a tool result.
  const last = request.messages.findLast((message) => message.role !== 'system')!
  if (last.role === 'toolResult') return fauxAssistantMessage(`Completed: ${textOf(last.content)}`)
  if (user === 'WRITE_SHARED')
    return fauxAssistantMessage(
      [fauxToolCall('write', { path: 'shared.txt', content: 'Shared workspace payload' })],
      { stopReason: 'toolUse' },
    )
  if (user === 'READ_SHARED')
    return fauxAssistantMessage([fauxToolCall('read', { path: 'shared.txt' })], {
      stopReason: 'toolUse',
    })
  if (user === 'DELEGATE_WRITE')
    return fauxAssistantMessage(
      [fauxToolCall('subagent', { action: 'start', agent: 'neutral', task: 'CHILD_WRITE' })],
      { stopReason: 'toolUse' },
    )
  if (user === 'CHILD_WRITE')
    return fauxAssistantMessage(
      [fauxToolCall('write', { path: 'child.txt', content: 'Child shared output' })],
      { stopReason: 'toolUse' },
    )
  const to = /^SEND (.+)$/.exec(user)?.[1]
  if (to)
    return fauxAssistantMessage(
      [fauxToolCall('agent_message', { to, text: 'Ordinary question', reply: true })],
      { stopReason: 'toolUse' },
    )
  return fauxAssistantMessage(`Answer: ${user}`)
}
async function submit(channel: ChannelHost, id: number, text: string, requestId = text) {
  const receipt = await channel.conversations.submit(id, { text, requestId })
  await until(
    async () =>
      !['active', 'queued'].includes(
        (await channel.conversations.submission(id, receipt.submissionId)).status,
      ),
  )
  expect(await channel.conversations.submission(id, receipt.submissionId)).toMatchObject({
    status: 'answered',
  })
  return receipt
}
async function history(channel: ChannelHost, id: number) {
  return (await channel.conversations.history(id, { direction: 'older', limit: 100 })).items
}
async function historyText(channel: ChannelHost, id: number) {
  return (await history(channel, id))
    .flatMap((item) =>
      'content' in item
        ? item.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
}

it('loads only the retained services and neutral definitions, without coding module fallbacks', async () => {
  const f = await agentCoreFixture()
  fixtures.push(f)
  const channel = await f.open(answer)
  expect((await readdir(join(f.source, 'extensions'))).toSorted()).toEqual(
    [...agentCoreExtensions].toSorted(),
  )
  for (const name of [
    'workspaces',
    'lineage',
    'coding-workflow',
    'agent',
    'sidebar',
    'onboarding',
    'prompt',
    'dream',
  ])
    await expect(access(join(f.source, 'extensions', name))).rejects.toThrow('ENOENT')
  await expect(access(join(f.source, 'extensions/automations/supervisor.ts'))).rejects.toThrow(
    'ENOENT',
  )
  await expect(access(join(f.workspace, '.git'))).rejects.toThrow('ENOENT')
  const definitions = await discoverAgents(
    f.source,
    f.workspace,
    f.userHome,
    f.prepared.modelRuntime,
  )
  expect(definitions.errors).toEqual([])
  expect(definitions.definitions.map((definition) => definition.name)).toEqual(['neutral'])
  expect(
    f.extensions
      .info()
      .map((extension) => extension.name)
      .toSorted(),
  ).toEqual([...agentCoreExtensions].toSorted())
  expect(f.extensions.info().every((extension) => !extension.server?.error)).toBe(true)
  expect(f.extensions.catalogue().missing).toEqual([])
  expect(f.extensions.catalogue().cycles).toEqual([])
  await expect(f.extensions.info.diagnostics()).resolves.toEqual([])
  const loaded = f.loadedModules()
  for (const name of agentCoreExtensions)
    expect(loaded.some((file) => file.includes(`/extensions/${name}/server.ts`))).toBe(true)
  expect(
    loaded.some((file) =>
      /\/extensions\/(workspaces|lineage|coding-workflow|agent|sidebar|onboarding|prompt|dream)\//.test(
        file,
      ),
    ),
  ).toBe(false)
  expect(
    f.prepared.registry
      .snapshot()
      .installed()
      .map((extension) => extension.name)
      .toSorted(),
  ).toEqual([...agentCoreExtensions, 'model-trace'].toSorted())
  const taskKinds = f.prepared.registry
    .snapshot()
    .installed()
    .flatMap((extension) => extension.tasks?.map((task) => task.definition.name) ?? [])
  expect(taskKinds).toContain('board.delivery')
  expect(taskKinds).toContain('ultimate.automation-delivery')
  expect(taskKinds).not.toContain('board.route')
  expect(taskKinds).not.toContain('board.notice')
  const chat = await channel.conversations.create({ title: 'Neutral chat' })
  await submit(channel, chat.id, 'Ordinary chat')
  expect(await historyText(channel, chat.id)).toContain('Answer: Ordinary chat')
  expect(f.notices).toEqual([])
})
it.each([false, true])(
  'recovers chapter state and native receipts without Dream: interrupted = %s',
  async (interrupted) => {
    const f = await agentCoreFixture()
    fixtures.push(f)
    await expect(access(join(f.source, 'extensions/dream'))).rejects.toThrow('ENOENT')
    await f.open(answer)
    const home = f.prepared.home
    for (const path of ['chapters.json', 'chapters', 'pending-chapter.json'])
      await expect(access(join(home, path))).rejects.toThrow('ENOENT')
    const first = await f.channel.conversations.create({ definition: 'neutral' })
    const receipt = await submit(
      f.channel,
      first.id,
      'Retain the first history',
      'retained-receipt',
    )
    const entries = await history(f.channel, first.id)
    await f.release()
    await requestChapter(home, 'next')
    let failure = ''
    if (interrupted)
      await finishChapterSwitch(home, async (file) => {
        await (await openNodeSqliteStorage(file)).close(context)
        throw new Error('Test interruption after database creation')
      }).catch((error: unknown) => {
        failure = String(error)
      })
    expect(failure).toBe(interrupted ? 'Error: Test interruption after database creation' : '')
    await f.open(answer)
    expect(f.prepared.database).toBe(join(home, 'chapters/next/state.sqlite'))
    await expect(access(join(home, 'pending-chapter.json'))).rejects.toThrow('ENOENT')
    const later = await f.channel.conversations.create({ definition: 'neutral' })
    expect(later.id).toBeGreaterThan(first.id)
    await submit(f.channel, later.id, 'Retain the next history')
    await f.release()
    // Existing metadata, with no new journal, must reopen the selected chapter rather than an empty first one.
    await f.open(answer)
    expect(f.prepared.database).toBe(join(home, 'chapters/next/state.sqlite'))
    expect((await f.channel.conversations.get(later.id)).configuration.definition).toBe('neutral')
    expect(await historyText(f.channel, later.id)).toContain('Answer: Retain the next history')
    await f.release()
    await requestChapter(home, FIRST_CHAPTER)
    await f.open(answer)
    expect(f.prepared.database).toBe(join(home, 'state.sqlite'))
    expect((await f.channel.conversations.get(first.id)).configuration.definition).toBe('neutral')
    expect(await history(f.channel, first.id)).toEqual(entries)
    expect(
      await submit(f.channel, first.id, 'Retain the first history', 'retained-receipt'),
    ).toEqual(receipt)
    expect(await history(f.channel, first.id)).toEqual(entries)
    const next = await f.channel.conversations.create({})
    expect(next.id).toBeGreaterThan(later.id)
    expect(f.extensions.catalogue()).toMatchObject({ missing: [], cycles: [] })
  },
)

it('keeps histories separate while file tools, child agents and messages share the workspace', async () => {
  const f = await agentCoreFixture()
  fixtures.push(f)
  const transcripts: string[] = []
  const channel = await f.open((request) => {
    if (['READ_SHARED', 'CHILD_WRITE'].includes(latestUser(request)))
      transcripts.push(JSON.stringify(request.messages))
    return answer(request)
  })
  const left = await channel.conversations.create({ title: 'Left' })
  const right = await channel.conversations.create({ title: 'Right' })
  await submit(channel, left.id, 'PRIVATE_LEFT')
  await submit(channel, right.id, 'PRIVATE_RIGHT')
  await submit(channel, left.id, 'WRITE_SHARED')
  await submit(channel, right.id, 'READ_SHARED')
  expect(await readFile(join(f.workspace, 'shared.txt'), 'utf8')).toBe('Shared workspace payload')
  expect(await historyText(channel, right.id)).toContain('Shared workspace payload')
  expect(await historyText(channel, right.id)).not.toContain('PRIVATE_LEFT')
  expect(await historyText(channel, left.id)).not.toContain('PRIVATE_RIGHT')
  await submit(channel, left.id, 'DELEGATE_WRITE')
  expect(await readFile(join(f.workspace, 'child.txt'), 'utf8')).toBe('Child shared output')
  expect(transcripts.every((request) => !request.includes('PRIVATE_LEFT'))).toBe(true)
  const children = (await channel.conversations.list()).filter(
    (conversation) => conversation.parentConversationId === left.id,
  )
  expect(children).toHaveLength(1)
  expect(children[0].cwd).toBe(f.workspace)
  await submit(channel, left.id, `SEND #${right.id}`)
  await until(async () =>
    (await history(channel, left.id)).some(
      (item) => item.type === 'other' && item.kind === 'board.reply',
    ),
  )
  await submit(channel, left.id, 'SEND @neutral')
  await until(
    async () =>
      (await history(channel, left.id)).filter(
        (item) => item.type === 'other' && item.kind === 'board.reply',
      ).length === 2,
  )
  await expect(access(join(f.workspace, '.git'))).rejects.toThrow('ENOENT')
  expect(f.extensions.catalogue().missing).toEqual([])
})

it('runs schedules and event notifications without a supervisor or fixed coordinator', async () => {
  const f = await agentCoreFixture()
  fixtures.push(f)
  const channel = await f.open(answer)
  const left = await channel.conversations.create({ title: 'Schedule subscriber' })
  const right = await channel.conversations.create({ title: 'Event subscriber' })
  const invoke = (action: string, args: JsonValue) =>
    f.extensions.invoke('automations', action, args, new AbortController().signal, left.id)
  const scheduled = (await invoke('create', {
    name: 'Ordinary schedule',
    schedule: 'every 1d',
    subscribers: [left.id],
  })) as Automation
  const event = (await invoke('create', {
    name: 'Escalation event',
    event: { name: 'automations.escalated', where: { id: scheduled.id } },
    subscribers: [right.id],
  })) as Automation
  await invoke('pause', { id: scheduled.id })
  await invoke('resume', { id: scheduled.id })
  for (let i = 0; i < 7; i++) await invoke('run', { id: scheduled.id })
  await until(async () =>
    (await history(channel, left.id)).some(
      (item) => item.type === 'other' && item.kind === 'automations.escalated',
    ),
  )
  await until(async () =>
    (await history(channel, right.id)).some(
      (item) => item.type === 'other' && item.kind === 'automations.fired',
    ),
  )
  const records = (await invoke('list', {})) as Automation[]
  expect(records.find((record) => record.id === scheduled.id)).toMatchObject({
    fires: 6,
    enabled: false,
  })
  expect(records.find((record) => record.id === event.id)).toMatchObject({ fires: 1 })
  expect(f.extensions.catalogue().missing).toEqual([])
  await expect(f.extensions.info.diagnostics()).resolves.toEqual([])
})
it('recovers a pending child report, message reply and schedule once through the real lifecycle', async () => {
  const f = await agentCoreFixture()
  fixtures.push(f)
  await f.open(recoveryModel(true))
  const ids = await pendingAgentCore(f)
  await f.release()
  await f.open(recoveryModel(false))
  expect(await recoveredAgentCore(f, ids)).toMatchObject({
    childReports: 1,
    messageReplies: 1,
    notifications: 1,
    childRecovered: true,
    messageRecovered: true,
    scheduleRuns: 1,
    scheduleAnswer: 'SCHEDULE_RECOVERED',
    schedulerRecovered: true,
    diagnostics: [],
    missing: [],
    cycles: [],
  })
  await f.release()
  const channel = await f.open(recoveryModel(false))
  const items = await history(channel, ids.parent)
  for (const kind of ['subagents.report', 'board.reply', 'automations.fired'])
    expect(items.filter((item) => item.type === 'other' && item.kind === kind)).toHaveLength(1)
})

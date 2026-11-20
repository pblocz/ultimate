import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Family, Profile } from '../shared/conversation-configuration.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Summaries } from '../extensions/conversations/summary.ts'
import { writeFamilies } from '../lib/families-settings.ts'
import { context } from '../server/harness.ts'
import { agentCoreFixture } from './agent-core-fixture.ts'
import { held, until } from './helpers.ts'

const fixtures: Awaited<ReturnType<typeof agentCoreFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close()
    await rm(f.root, { recursive: true, force: true })
  }
})
async function fixture(pending = false) {
  const f = await agentCoreFixture({
    models: [{ id: 'faux-1' }, { id: 'faux-2', reasoning: true }],
  })
  fixtures.push(f)
  await writeFile(
    join(f.source, 'agents/helper.md'),
    '---\nname: helper\ndescription: Configurable helper\ntools: [read]\nmodel: faux/faux-1\nsummaries: false\n---\nSelected helper instructions.\n',
  )
  await writeFile(
    join(f.source, 'agents/writer.md'),
    '---\nname: writer\ndescription: Writer\ntools: [read, write]\n---\nWriter instructions.\n',
  )
  await writeFamilies(f.userHome, f.workspace, {
    families: {
      quick: { model: 'faux/faux-1', thinking: 'off' },
      deliberate: { model: 'faux/faux-2', thinking: 'high' },
    },
  })
  const channel = await f.open(pending ? held : () => fauxAssistantMessage('Done'))
  return { f, channel }
}
async function agent(f: Awaited<ReturnType<typeof agentCoreFixture>>, id: number) {
  return (await f.harness.conversation(id as ConversationId, context))!.agent(context)
}

it('creates independent chats with an existing definition and different presets in one native transaction', async () => {
  const { f, channel } = await fixture()
  const left = await channel.conversations.create({ definition: 'helper', preset: 'quick' })
  const right = await channel.conversations.create({ definition: 'helper', preset: 'deliberate' })
  expect(left.id).not.toBe(right.id)
  expect((await channel.conversations.get(left.id)).configuration).toMatchObject({
    definition: 'helper',
    preset: 'quick',
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'off',
  })
  expect((await channel.conversations.get(right.id)).configuration).toMatchObject({
    definition: 'helper',
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
    thinkingLevel: 'high',
  })
  for (const id of [left.id, right.id]) {
    expect((await agent(f, id)).tools.map((tool) => tool.name)).toEqual(['read'])
    expect((await agent(f, id)).cwd).toBe(f.workspace)
    expect((await f.harness.snapshot(Summaries, id as ConversationId, context))?.automatic).toBe(
      false,
    )
    expect((await channel.conversations.history(id, { direction: 'older' })).items).toEqual([])
  }
  expect(
    (await f.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.helper,
  ).toBeUndefined()
})

it('rejects invalid selections before creation and keeps existing configuration atomic', async () => {
  const { f, channel } = await fixture()
  await writeFile(
    join(f.source, 'agents/isolated.md'),
    '---\nname: isolated\ndescription: Worktree\ntools: [read]\nisolate: worktree\n---\nIsolated work.\n',
  )
  const count = (await channel.conversations.list()).length
  for (const input of [
    { definition: 'missing' },
    { preset: 'missing' },
    { model: { provider: 'missing', modelId: 'missing' } },
    { definition: 'helper', preset: 'deliberate', thinkingLevel: 'bogus' },
    { preset: 'deliberate', model: { provider: 'faux', modelId: 'faux-1' } },
  ])
    await expect(channel.conversations.create(input as never)).rejects.toMatchObject({
      code: 'invalid_input',
    })
  await expect(channel.conversations.create({ definition: 'isolated' })).rejects.toMatchObject({
    code: 'unavailable',
  })
  expect((await channel.conversations.list()).length).toBe(count)
  const chat = await channel.conversations.create({ definition: 'helper', preset: 'quick' })
  const before = await f.harness.snapshot(AgentDoc, chat.id as ConversationId, context)
  await expect(
    channel.conversations.configure(chat.id, { definition: 'writer', preset: 'missing' }),
  ).rejects.toMatchObject({ code: 'invalid_input' })
  expect(await f.harness.snapshot(AgentDoc, chat.id as ConversationId, context)).toEqual(before)
  expect(await f.harness.snapshot(Profile, chat.id as ConversationId, context)).toEqual({
    definition: 'helper',
  })
  expect(await f.harness.snapshot(Family, chat.id as ConversationId, context)).toEqual({
    name: 'quick',
  })
})

it('changes profiles from the base inventory and changes models without losing the selected profile', async () => {
  const { f, channel } = await fixture()
  const chat = await channel.conversations.create({ definition: 'helper', preset: 'quick' })
  await channel.conversations.configure(chat.id, { definition: 'writer', preset: 'deliberate' })
  expect((await agent(f, chat.id)).tools.map((tool) => tool.name)).toEqual(['read', 'write'])
  await channel.conversations.configure(chat.id, { model: { provider: 'faux', modelId: 'faux-1' } })
  const result = (await channel.conversations.get(chat.id)).configuration
  expect(result.definition).toBe('writer')
  expect(result.preset).toBeUndefined()
  expect(result.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect((await agent(f, chat.id)).tools.map((tool) => tool.name)).toEqual(['read', 'write'])
  expect((await channel.conversations.history(chat.id, { direction: 'older' })).items).toEqual([])
})

it('rejects profile changes during a turn and does not allow a profile selector on the internal root', async () => {
  const { f, channel } = await fixture(true)
  const chat = await channel.conversations.create({ definition: 'helper' })
  await channel.conversations.submit(chat.id, { text: 'Wait' })
  await until(
    async () => !!(await f.harness.snapshot(LiveDoc, chat.id as ConversationId, context))?.run,
  )
  const before = await f.harness.snapshot(AgentDoc, chat.id as ConversationId, context)
  await expect(
    channel.conversations.configure(chat.id, { definition: 'writer' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(await f.harness.snapshot(AgentDoc, chat.id as ConversationId, context)).toEqual(before)
  await expect(
    channel.conversations.configure(ROOT_CONVERSATION_ID, { definition: 'writer' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await channel.conversations.stop(chat.id)
})

it('keeps the chosen preset when a persona that names no model is selected or cleared', async () => {
  const { f, channel } = await fixture()
  const chat = await channel.conversations.create({ preset: 'deliberate' })
  // `writer` names no model, family or thinking level: the persona changes, the model selection stays.
  await channel.conversations.configure(chat.id, { definition: 'writer' })
  expect((await channel.conversations.get(chat.id)).configuration).toEqual({
    definition: 'writer',
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
    thinkingLevel: 'high',
  })
  expect((await agent(f, chat.id)).instructions).toContain('Writer instructions.')
  await channel.conversations.configure(chat.id, { definition: null })
  expect((await channel.conversations.get(chat.id)).configuration).toEqual({
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
    thinkingLevel: 'high',
  })
  // `helper` pins a model, so selecting it applies that model and the preset no longer describes the chat.
  await channel.conversations.configure(chat.id, { definition: 'helper' })
  expect((await channel.conversations.get(chat.id)).configuration).toMatchObject({
    definition: 'helper',
    model: { provider: 'faux', modelId: 'faux-1' },
  })
  expect((await channel.conversations.get(chat.id)).configuration.preset).toBeUndefined()
})

it('publishes selected names in safe output snapshots and preserves them after reopen', async () => {
  const { f, channel } = await fixture()
  const chat = await channel.conversations.create({ definition: 'helper', preset: 'quick' })
  const watch = channel.conversations.watch(chat.id)[Symbol.asyncIterator]()
  expect((await watch.next()).value?.configuration).toMatchObject({
    definition: 'helper',
    preset: 'quick',
  })
  await channel.conversations.configure(chat.id, { preset: 'deliberate' })
  const changed = (await watch.next()).value!
  expect(changed.configuration).toMatchObject({ definition: 'helper', preset: 'deliberate' })
  expect(JSON.stringify(changed)).not.toContain('Selected helper instructions.')
  await watch.return?.()
  await f.release()
  await f.open(() => fauxAssistantMessage('Done'))
  expect((await f.channel.conversations.get(chat.id)).configuration).toMatchObject({
    definition: 'helper',
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
  })
})

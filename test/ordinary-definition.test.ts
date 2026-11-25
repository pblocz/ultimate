import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { applyDefinition, prepareDefinition } from '../server/conversation-configuration.ts'
import { context } from '../server/harness.ts'
import { Profile, Standing } from '../extensions/subagents/api.ts'
import { Family } from '../extensions/models/api.ts'
import { agentCoreFixture } from './agent-core-fixture.ts'

const fixtures: Awaited<ReturnType<typeof agentCoreFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close()
    await rm(f.root, { recursive: true, force: true })
  }
})
async function fixture() {
  const f = await agentCoreFixture()
  fixtures.push(f)
  await f.open(() => fauxAssistantMessage('Done'))
  const root = (await f.harness.conversation(ROOT_CONVERSATION_ID, context))!
  return { f, base: await root.agent(context) }
}

it('uses one capable definition in two independent ownerless conversations, not a resident singleton', async () => {
  const { f, base } = await fixture()
  await writeFile(
    join(f.source, 'agents/helper.md'),
    '---\nname: helper\ndescription: Shared helper\nresident: true\ntools: [read, write]\ndenyTools: [write]\nmodel: faux/faux-1\nsummaries: false\nfast: true\n---\nUse the selected helper instructions.\n',
  )
  const prepared = await prepareDefinition(f.prepared, base, 'helper')
  expect(prepared.definition).toMatchObject({ summaries: false, fast: true, resident: true })
  const ids = await f.harness.commit(async (tx) => {
    const left = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    const right = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await applyDefinition(tx, left.id, prepared)
    await applyDefinition(tx, right.id, prepared)
    return [left.id, right.id]
  }, context)
  expect(ids[0]).not.toBe(ids[1])
  for (const id of ids) {
    const conversation = (await f.harness.conversation(id, context))!
    const agent = await conversation.agent(context)
    expect(agent.instructions?.trim()).toBe('Use the selected helper instructions.')
    expect(agent.tools.map((tool) => tool.name)).toEqual(['read'])
    expect(agent.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
    expect(await f.harness.snapshot(Profile, id, context)).toEqual({ definition: 'helper' })
    expect((await conversation.entries({}, 100, undefined, context)).items).toEqual([])
    expect((await f.harness.commit((tx) => tx.conversation(id), context))?.owner).toBeUndefined()
  }
  expect(
    (await f.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.helper,
  ).toBeUndefined()
})

it('uses existing user/project overlays and the base tool inventory when another profile is selected', async () => {
  const { f, base } = await fixture()
  await writeFile(
    join(f.source, 'agents/helper.md'),
    '---\nname: helper\ndescription: Helper\ntools: [read]\n---\nBase instructions.\n',
  )
  await mkdir(join(f.userHome, '.ultimate/agents'), { recursive: true })
  await mkdir(join(f.workspace, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(f.userHome, '.ultimate/agents/helper.md'),
    '---\nname: helper\naddTools: [write]\n---\nUser instructions.\n',
  )
  await writeFile(
    join(f.workspace, '.ultimate/agents/helper.md'),
    '---\nname: helper\naddTools: [edit]\ndenyTools: [write]\n---\nProject instructions.\n',
  )
  new ProjectTrustStore(join(f.userHome, '.ultimate')).set(f.workspace, true)
  const selection = await prepareDefinition(f.prepared, base, 'helper')
  expect(selection.change.instructions).toContain('User instructions.')
  expect(selection.change.instructions).toContain('Project instructions.')
  const first = await prepareDefinition(f.prepared, base, 'neutral')
  const id = await f.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await applyDefinition(tx, conversation.id, first)
    await applyDefinition(tx, conversation.id, selection)
    return conversation.id
  }, context)
  const agent = await (await f.harness.conversation(id, context))!.agent(context)
  expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'edit'])
  expect(await f.harness.snapshot(Profile, id, context)).toEqual({ definition: 'helper' })
})

it('preserves model overrides and resolves existing worktree settings without inventing an isolate', async () => {
  const { f, base } = await fixture()
  await writeFile(
    join(f.source, 'agents/isolated.md'),
    '---\nname: isolated\ndescription: Isolated helper\ntools: [read]\nisolate: worktree\nfamily: default\n---\nWork in the requested isolate.\n',
  )
  const model = { provider: 'faux', modelId: 'faux-1' }
  const selection = await prepareDefinition(f.prepared, base, 'isolated', { model })
  expect(selection.requirement).toBe('worktree')
  expect(selection.change.model).toEqual(model)
  expect(selection.family).toBeNull()
  const neutral = await prepareDefinition(f.prepared, base, 'neutral')
  expect(neutral.requirement).toBe('none')
  expect((await prepareDefinition(f.prepared, base, null)).requirement).toBeUndefined()
  await expect(prepareDefinition(f.prepared, base, 'missing')).rejects.toMatchObject({
    code: 'invalid_input',
  })
})

it('clears a definition through the native base configuration, without retaining the old tool restriction', async () => {
  const { f, base } = await fixture()
  const chosen = await prepareDefinition(f.prepared, base, 'neutral')
  const cleared = await prepareDefinition(f.prepared, base, null)
  const id = await f.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await applyDefinition(tx, conversation.id, chosen)
    await applyDefinition(tx, conversation.id, cleared)
    return conversation.id
  }, context)
  const agent = await (await f.harness.conversation(id, context))!.agent(context)
  expect(agent.tools.map((tool) => tool.name)).toEqual(base.tools.map((tool) => tool.name))
  expect(await f.harness.snapshot(Profile, id, context)).toEqual({})
  expect(await f.harness.snapshot(Family, id, context)).toEqual({ name: null })
})

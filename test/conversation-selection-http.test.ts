import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Family, Profile } from '../shared/conversation-configuration.ts'
import { writeFamilies } from '../lib/families-settings.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
async function fixture() {
  const home = await temp('ultimate-selection-http-')
  cleanup.push(() => removeTemp(home))
  const projectRoot = join(home, 'workspace')
  const userHome = join(home, 'user')
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/agents/helper.md'),
    '---\nname: helper\ndescription: Ordinary helper\ntools: [read]\n---\nHelper instructions.\n',
  )
  await writeFamilies(userHome, projectRoot, {
    families: {
      quick: { model: 'faux/faux-1', thinking: 'off' },
      deliberate: { model: 'faux/faux-2', thinking: 'high' },
    },
  })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(home, 'state'),
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2', reasoning: true }] }),
  })
  cleanup.push(() => server.close())
  const state = async (id: number) => {
    const conversation = (await server.harness.conversation(id as ConversationId, context))!
    const agent = await conversation.agent(context)
    return {
      definition: (await server.harness.snapshot(Profile, id as ConversationId, context))
        ?.definition,
      preset: (await server.harness.snapshot(Family, id as ConversationId, context))?.name,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      tools: agent.tools.map((tool) => tool.name),
    }
  }
  return { server, state }
}

it('creates two chats with one persona and different presets through the web endpoint', async () => {
  const { server, state } = await fixture()
  const left = await post(server, '/api/conversations', { definition: 'helper', preset: 'quick' })
  const right = await post(server, '/api/conversations', {
    definition: 'helper',
    preset: 'deliberate',
  })
  expect([left.status, right.status]).toEqual([201, 201])
  expect(await state(left.data.id)).toEqual({
    definition: 'helper',
    preset: 'quick',
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'off',
    tools: ['read'],
  })
  expect(await state(right.data.id)).toEqual({
    definition: 'helper',
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
    thinkingLevel: 'high',
    tools: ['read'],
  })
})

it('keeps the persona and tools when the model changes, and clears only the preset for a direct model', async () => {
  const { server, state } = await fixture()
  const { data } = await post(server, '/api/conversations', {
    definition: 'helper',
    preset: 'quick',
  })
  const configure = (change: object) =>
    post(server, `/api/conversations/${data.id}/configure`, change)
  expect((await configure({ preset: 'deliberate' })).status).toBe(200)
  expect(await state(data.id)).toMatchObject({
    definition: 'helper',
    preset: 'deliberate',
    model: { provider: 'faux', modelId: 'faux-2' },
    tools: ['read'],
  })
  expect((await configure({ model: { provider: 'faux', modelId: 'faux-1' } })).status).toBe(200)
  expect(await state(data.id)).toMatchObject({
    definition: 'helper',
    preset: null,
    model: { provider: 'faux', modelId: 'faux-1' },
    tools: ['read'],
  })
  expect((await configure({ definition: null })).status).toBe(200)
  const cleared = await state(data.id)
  expect(cleared.definition).toBeUndefined()
  expect(cleared.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
})

it('reports an invalid selection and creates no conversation', async () => {
  const { server } = await fixture()
  const before = server.conversations().length
  const missing = await post(server, '/api/conversations', { definition: 'missing' })
  const both = await post(server, '/api/conversations', {
    preset: 'quick',
    model: { provider: 'faux', modelId: 'faux-2' },
  })
  expect(missing.status).toBe(400)
  expect(missing.data.error).toBe('Unknown agent definition: missing')
  expect(both.status).toBe(400)
  expect(both.data.error).toBe('Choose a preset or a direct model, not both')
  expect(server.conversations()).toHaveLength(before)
})

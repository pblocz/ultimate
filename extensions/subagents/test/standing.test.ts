import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
// Harness tests use the faux provider without token pacing.
import { apis, eventHost, fauxServer, idleNeed, temp, removeTemp } from '@ultimate/test/helpers.ts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { obj } from '@earendil-works/pi-schema'
import {
  configure,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { prepareHarness } from '@ultimate/server/harness.ts'
import { emit } from '@ultimate/server/events.ts'
import type { OpenHost } from '@ultimate/server/harness.ts'
import subagents from '../server.ts'
import { Profile, Standing, Started, SubagentsWorkflow } from '../api.ts'
import type { SubagentsService } from '../api.ts'
import { Metadata } from '@ultimate/server/metadata.ts'
import { Marks } from '@ultimate/ext/conversations/api.ts'
import { parseDefinition, saveDefinition } from '@ultimate/lib/agents.ts'

it('keeps an edit a turn applied while a standing call was waiting to commit', async () => {
  const { service, host, file, hold } = await fixture()
  const id = await service.standing('x', ctx)
  const gate = hold()
  const refresh = service.standing('x', ctx)
  await gate.reached
  await writeFile(file, definition('Edited'))
  await host.harness.commit((tx) => configure(tx, id, { instructions: 'Edited' }), ctx)
  gate.release()
  expect(await refresh).toBe(id)
  expect(await (await host.harness.conversation(id, ctx))!.agent(ctx)).toMatchObject({
    instructions: 'Edited',
  })
})

it('retires the agent when its definition stops being resident while a standing call was waiting to commit', async () => {
  const { service, host, file, hold } = await fixture()
  const id = await service.standing('x', ctx)
  const gate = hold()
  const refresh = service.standing('x', ctx)
  await gate.reached
  await writeFile(file, definition('Original').replace('resident: true', 'resident: false'))
  gate.release()
  await expect(refresh).rejects.toThrow('Unknown standing agent @x')
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({})
  expect(await host.harness.snapshot(Metadata, id, ctx)).not.toHaveProperty('label')
})

const ctx = BACKGROUND_CONTEXT
const directories: string[] = []
const opened: OpenHost[] = []
afterEach(async () => {
  for (const host of opened.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const definition = (body: string, extra = '') =>
  `---\nname: x\ndescription: Test\nresident: true\ntools: [read, t]\nisolate: worktree\n${extra}---\n${body}\n`
async function fixture(onDemand?: (name: string) => boolean) {
  const path = await temp('ultimate-standing-')
  directories.push(path)
  const prepared = await prepareHarness({
    ultimateRoot: path,
    userHome: path,
    home: join(path, 'state'),
    faux: fauxProvider({
      models: [
        { id: 'faux-1', reasoning: true },
        { id: 'faux-pinned', reasoning: true },
      ],
    }),
  })
  const tool = defineTool({
    name: 't',
    description: 'Owned tool',
    deferred: true,
    parameters: obj({}),
    execute: async () => ({ output: [] }),
  })
  prepared.registry.install(CodingTools)
  prepared.registry.install(defineExtension({ name: 'owned', tools: [tool] }))
  let host!: OpenHost
  let service!: SubagentsService
  const openers: (() => Promise<void>)[] = []
  const providers = new Map<string, unknown>()
  if (onDemand) providers.set(SubagentsWorkflow.name, { onDemand })
  // Holds the next commit the extension makes until `release`, so a test edits a definition between a call's start
  // and its commit.
  let held: { reached: () => void; release: Promise<void> } | undefined
  const hold = () => {
    let reached!: () => void
    let release!: () => void
    const gate = {
      reached: new Promise<void>((done) => (reached = done)),
      release: new Promise<void>((done) => (release = done)),
    }
    held = { reached, release: gate.release }
    return { reached: gate.reached, release }
  }
  const gated = (): OpenHost['harness'] =>
    new Proxy(host.harness, {
      get(target, property) {
        if (property !== 'commit') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: Parameters<typeof target.commit>) => {
          const gate = held
          held = undefined
          if (gate) {
            gate.reached()
            await gate.release
          }
          return target.commit(...args)
        }
      },
    })
  const backend = subagents({
    ...prepared,
    harness: gated,
    metadata: Metadata,
    projectSettings: async () => ({}),
    implement: (_api, value) => {
      service = value as SubagentsService
    },
    need: idleNeed,
    want: apis(providers).want,
    resource: (_key, create) => create(),
    extensions: () => [],
    notice: () => {},
    onOpen: (callback) => openers.push(callback),
    onClose: () => {},
    emit,
  })
  prepared.registry.install(backend)
  host = await prepared.open()
  opened.push(host)
  await mkdir(join(path, 'agents'))
  const file = join(path, 'agents/x.md')
  await writeFile(file, definition('Original'))
  const reopen = async () => {
    for (const callback of openers) await callback()
  }
  const open = async () => {
    host = await prepared.open()
    opened.push(host)
    return host
  }
  return { path, prepared, host, service, file, reopen, open, providers, hold }
}

it('starts every resident without a workflow, including an operator-defined ultimate', async () => {
  const f = await fixture()
  await writeFile(
    join(f.path, 'agents/ultimate.md'),
    definition('Ordinary resident').replace('name: x', 'name: ultimate'),
  )
  await f.reopen()
  const index = await f.host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  expect(index?.x).toBeDefined()
  expect(index?.ultimate).toBeDefined()
})
it('replaces only the requested standing address and rejects a stale target', async () => {
  const { service, host, path } = await fixture()
  await writeFile(
    join(path, 'agents/ultimate.md'),
    definition('Ultimate resident').replace('name: x', 'name: ultimate'),
  )
  const ultimate = await service.standing('ultimate', ctx)
  const other = await service.standing('x', ctx)
  const newUltimate = await service.replaceStanding('ultimate', ultimate, ctx)
  expect(newUltimate).not.toBe(ultimate)
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({
    ultimate: newUltimate,
    x: other,
  })
  await expect(service.replaceStanding('ultimate', ultimate, ctx)).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({
    ultimate: newUltimate,
    x: other,
  })
  const replacements = await Promise.allSettled([
    service.replaceStanding('x', other, ctx),
    service.replaceStanding('x', other, ctx),
  ])
  const fresh = replacements.find((result) => result.status === 'fulfilled')?.value
  expect(fresh).toBeTypeOf('number')
  expect(fresh).not.toBe(other)
  expect(replacements.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'conflict' },
  })
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({
    ultimate: newUltimate,
    x: fresh,
  })
  expect((await host.harness.conversation(ultimate, ctx))?.id).toBe(ultimate)
  expect((await host.harness.conversation(other, ctx))?.id).toBe(other)
  expect(await host.harness.snapshot(Profile, newUltimate, ctx)).toEqual({ definition: 'ultimate' })
})

it('uses the current optional workflow to defer any resident until requested', async () => {
  const f = await fixture((name) => name === 'x')
  await f.reopen()
  expect((await f.host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.x).toBeUndefined()
  f.providers.clear()
  await f.reopen()
  expect((await f.host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.x).toBeDefined()
})
it('lists definitions only to agents that can use them', async () => {
  const { service, host, prepared } = await fixture()
  const standing = (await host.harness.conversation(await service.standing('x', ctx), ctx))!
  const section = prepared.registry
    .snapshot()
    .extension('subagents')!
    .sections!.find((item) => item.key === 'subagents')!
  const agent = await standing.agent(ctx)
  const render = (tools = agent.tools, conversationId = standing.id) =>
    section.render(
      { conversationId, agent: { ...agent, tools } } as Parameters<typeof section.render>[0],
      ctx,
    )
  expect(await render()).toBeUndefined()
  for (const name of ['branch', 'automation']) {
    const text = await render([{ ...agent.tools[0], name }])
    expect(text).toBe('Available definitions:\nx (default): Test')
  }
  const coordinator = await host.root.agent(ctx)
  expect(coordinator.tools.some((tool) => tool.name === 'subagent')).toBe(true)
  const text = await render(coordinator.tools, host.root.id)
  expect(text).toContain('Available definitions:\n')
  expect(text).toContain('x (default): Test')
})

it('parses and saves the resident field, refusing non-booleans', async () => {
  const { path, prepared } = await fixture()
  expect(parseDefinition(definition('Instructions'), 'test').resident).toBe(true)
  expect(() =>
    parseDefinition(
      definition('Instructions').replace('resident: true', 'resident: "yes"'),
      'test',
    ),
  ).toThrow('resident must be a boolean')
  const saved = await saveDefinition(
    { projectRoot: path, userHome: path },
    prepared.modelRuntime,
    'user',
    'saved',
    { description: 'Saved', resident: true },
    'Instructions',
  )
  expect(saved.resident).toBe(true)
  expect(parseDefinition(await readFile(saved.path, 'utf8'), saved.path).resident).toBe(true)
})

it('reads, saves and publishes a standing agent mark and title', async () => {
  const { service, host, prepared, path, file } = await fixture()
  expect(() => parseDefinition(definition('Instructions', 'tint: purple\n'), 'test')).toThrow(
    'tint must be one of',
  )
  expect(() => parseDefinition(definition('Instructions', 'title: " "\n'), 'test')).toThrow(
    'title must be a nonempty string',
  )
  const saved = await saveDefinition(
    { projectRoot: path, userHome: path },
    prepared.modelRuntime,
    'user',
    'saved',
    { description: 'Saved', title: 'Notes', icon: 'notebook-pen', tint: 'teal' },
    'Instructions',
  )
  expect(parseDefinition(await readFile(saved.path, 'utf8'), saved.path)).toMatchObject({
    title: 'Notes',
    icon: 'notebook-pen',
    tint: 'teal',
  })
  await writeFile(file, definition('Instructions', 'icon: Gem\ntint: violet\n'))
  await service.standing('x', ctx)
  expect(await host.harness.snapshot(Marks, ROOT_CONVERSATION_ID, ctx)).toEqual({
    x: { icon: 'Gem', tint: 'violet' },
  })
  // A later folder's overlay names the agent without touching its address or instructions.
  const overlay = join(path, '.ultimate/agents/x.md')
  await mkdir(join(path, '.ultimate/agents'), { recursive: true })
  await writeFile(overlay, '---\nname: x\naddTools: []\ntitle: Atlas\n---\n')
  const id = await service.standing('x', ctx)
  expect(await host.harness.snapshot(Marks, ROOT_CONVERSATION_ID, ctx)).toEqual({
    x: { title: 'Atlas', icon: 'Gem', tint: 'violet' },
  })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({ title: '@x' })
  await rm(overlay)
  await writeFile(file, definition('Instructions'))
  await service.standing('x', ctx)
  expect(await host.harness.snapshot(Marks, ROOT_CONVERSATION_ID, ctx)).toEqual({})
})

it('keeps one ownerless standing conversation, refreshes its definition and recreates deleted records', async () => {
  const { service, host, prepared, path, file, open } = await fixture()
  expect(await service.residents(ctx)).toEqual([{ name: 'x', description: 'Test' }])
  const ids = await Promise.all([service.standing('x', ctx), service.standing('x', ctx)])
  expect(ids[0]).toBe(ids[1])
  const id = ids[0]
  expect(await service.standing('x', ctx)).toBe(id)
  const conversation = (await host.harness.conversation(id, ctx))!
  const record = await host.harness.commit((tx) => tx.conversation(id), ctx)
  expect(record?.owner).toBeUndefined()
  expect(await conversation.agent(ctx)).toMatchObject({ cwd: path, instructions: 'Original' })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({
    label: 'agent',
    title: '@x',
  })
  expect(await host.harness.snapshot(Profile, id, ctx)).toEqual({ definition: 'x' })
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({ x: id })
  await writeFile(file, definition('Edited', 'model: faux/faux-pinned\n'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: { provider: 'faux', modelId: 'faux-pinned' },
  })
  await expect(service.standing('missing', ctx)).rejects.toThrow('Standing agents: @x')
  await writeFile(
    join(path, 'agents/ordinary.md'),
    '---\nname: ordinary\ndescription: Ordinary\n---\nInstructions',
  )
  await expect(service.standing('ordinary', ctx)).rejects.toThrow('Standing agents: @x')
  // No public delete API: remove the record between sessions, outside Pi's live record cache.
  await host.close()
  opened.splice(opened.indexOf(host), 1)
  const database = new DatabaseSync(prepared.database)
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  database.close()
  const restored = await open()
  const recreated = await service.standing('x', ctx)
  expect(recreated).not.toBe(id)
  // Each new conversation starts once; repeats and refreshes start nothing.
  const log = eventHost(() => restored.harness, 'test').eventLog
  expect((await log.recent({ events: [Started] })).map((event) => event.data)).toEqual([
    {
      id: recreated,
      agent: 'x',
      kind: 'standing',
      model: 'faux/faux-pinned',
      thinking: 'off',
    },
    { id, agent: 'x', kind: 'standing', model: 'faux/faux-1', thinking: 'off' },
  ])
})

// #568566: a new chapter opened with an empty Standing document, so resident agents vanished until addressed.
it('keeps the full application primary agent on demand across reopen', async () => {
  const home = await temp('ultimate-primary-startup-')
  directories.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    expect(
      (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate,
    ).toBeUndefined()
    const id = (await server.extensions.invoke(
      'subagents',
      'standing',
      { name: 'ultimate' },
      new AbortController().signal,
    )) as number
    expect(id).toBeGreaterThan(server.root.id)
    expect((await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate).toBe(id)
    await server.release()
    const reopened = await server.go()
    expect((await reopened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate).toBe(
      id,
    )
  } finally {
    await server.close()
  }
})

it('gives every resident definition its conversation when the project opens, once', async () => {
  const { host, reopen } = await fixture()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toBeUndefined()
  await reopen()
  const index = await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  expect(index).toEqual({ x: expect.any(Number) })
  expect(await host.harness.snapshot(Metadata, index!.x, ctx)).toMatchObject({ title: '@x' })
  await reopen()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual(index)
})

it('retires a standing agent whose definition is deleted on the next open, only once every definition parses', async () => {
  const { service, host, path, file, reopen } = await fixture()
  const id = await service.standing('x', ctx)
  await writeFile(
    join(path, 'agents/y.md'),
    '---\nname: y\ndescription: Kept\nresident: true\n---\nY',
  )
  const kept = await service.standing('y', ctx)
  await rm(file)
  // A broken file may define any agent: its error names the file, so retirement waits.
  const broken = join(path, 'agents/renamed.md')
  await writeFile(broken, '---\nname: x\nresident: [\n---\nBroken')
  await reopen()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({
    x: id,
    y: kept,
  })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({ label: 'agent' })
  await rm(broken)
  await reopen()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({ y: kept })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toEqual({ title: '@x' })
  const retired = await host.harness.conversation(id, ctx)
  expect(await retired!.agent(ctx)).toMatchObject({ instructions: 'Original' })
})

it('keeps a model chosen in the standing conversation across refreshes unless the definition pins one', async () => {
  const { service, host, file } = await fixture()
  await host.harness.commit(async (tx) => {
    await configure(tx, ROOT_CONVERSATION_ID, {
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
    })
  }, ctx)
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect(await conversation.agent(ctx)).toMatchObject({
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
  })
  const chosen = { provider: 'openai', modelId: 'gpt-6-astra' }
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { model: chosen, thinkingLevel: 'high' })
  }, ctx)
  await writeFile(file, definition('Edited'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: chosen,
    thinkingLevel: 'high',
  })
  await writeFile(file, definition('Pinned', 'model: faux/faux-pinned\nthinking: minimal\n'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Pinned',
    model: { provider: 'faux', modelId: 'faux-pinned' },
    thinkingLevel: 'minimal',
  })
})

it('offers deferred tools only when named by the definition, and removes them on refresh', async () => {
  const { service, host, file } = await fixture()
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read', 't'])
  await writeFile(file, definition('No owned tool').replace('tools: [read, t]', 'tools: [read]'))
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { tools: [] })
  }, ctx)
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
})

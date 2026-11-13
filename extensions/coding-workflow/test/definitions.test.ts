import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { discoverAgents } from '../../../lib/agents.ts'
import { prepareHarness } from '../../../server/harness.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
async function fixture() {
  const root = await temp('ultimate-feature-definitions-')
  directories.push(root)
  const project = join(root, 'project')
  const userHome = join(root, 'user')
  await mkdir(project)
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  new ProjectTrustStore(join(userHome, '.ultimate')).set(project, true)
  const prepared = await prepareHarness({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(root, 'state'),
    faux: fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] }),
  })
  return {
    project,
    userHome,
    discover: () => discoverAgents(resolve('.'), project, userHome, prepared.modelRuntime),
  }
}

it('supplies bundled definitions only through their enabled owners', async () => {
  const f = await fixture()
  expect(await readdir(resolve('agents'))).toEqual(['scout.md'])
  const found = await f.discover()
  expect(found.errors).toEqual([])
  const owners = {
    ultimate: 'coding-workflow',
    coordinator: 'coding-workflow',
    worker: 'coding-workflow',
    designer: 'coding-workflow',
    reviewer: 'coding-workflow',
    'dream-pass': 'dream',
    watcher: 'automations',
  }
  expect(found.definitions.map((definition) => definition.name).toSorted()).toEqual(
    [...Object.keys(owners), 'scout'].toSorted(),
  )
  for (const [name, owner] of Object.entries(owners))
    expect(found.definitions.find((definition) => definition.name === name)?.path).toBe(
      resolve('extensions', owner, 'agents', `${name}.md`),
    )
  await writeFile(
    join(f.userHome, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: { disable: ['coding-workflow', 'dream', 'automations'] },
    }),
  )
  const disabled = await f.discover()
  expect(disabled.errors).toEqual([])
  expect(disabled.definitions.map((definition) => definition.name)).toEqual(['scout'])
})
it('preserves user and project overlays on extension-owned definitions', async () => {
  const f = await fixture()
  const user = join(f.userHome, '.ultimate/agents/worker.md')
  const project = join(f.project, '.ultimate/agents/worker.md')
  await mkdir(join(f.userHome, '.ultimate/agents'), { recursive: true })
  await mkdir(join(f.project, '.ultimate/agents'), { recursive: true })
  await writeFile(
    user,
    '---\nname: worker\naddTools: [debug]\nfamily: lead\nisolate: none\n---\nUser addition.\n',
  )
  await writeFile(
    project,
    '---\nname: worker\naddTools: [recall]\nthinking: high\n---\nProject addition.\n',
  )
  const found = await f.discover()
  expect(found.errors).toEqual([])
  const worker = found.definitions.find((definition) => definition.name === 'worker')!
  expect(worker).toMatchObject({
    family: 'lead',
    thinking: 'high',
    isolate: 'none',
    source: 'builtin',
    addTools: ['debug', 'recall'],
    overlays: [user, project],
    denyTools: ['instance'],
  })
  expect(worker.instructions).toContain('Implement exactly the assigned task')
  expect(worker.instructions.indexOf('User addition.')).toBeLessThan(
    worker.instructions.indexOf('Project addition.'),
  )
})
it('lets a project definition replace an extension-owned definition', async () => {
  const f = await fixture()
  const file = join(f.project, '.ultimate/agents/worker.md')
  await mkdir(join(f.project, '.ultimate/agents'), { recursive: true })
  await writeFile(
    file,
    '---\nname: worker\ndescription: Project worker\nmodel: faux/faux-1\ntools: [read]\n---\nProject replacement.\n',
  )
  const found = await f.discover()
  expect(found.errors).toEqual([])
  expect(found.definitions.find((definition) => definition.name === 'worker')).toMatchObject({
    source: 'project',
    path: file,
    tools: ['read'],
    instructions: 'Project replacement.',
    model: { provider: 'faux', modelId: 'faux-1' },
  })
  expect(found.replaced).toContainEqual({ name: 'worker', path: file, source: 'project' })
})

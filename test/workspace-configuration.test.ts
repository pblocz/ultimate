import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverAgents } from '../lib/agents.ts'
import { familiesPath, readFamilies, writeFamilies } from '../lib/families-settings.ts'
import { discoverExtensions } from '../server/discovery.ts'
import { prepareHarness } from '../server/harness.ts'
import { projectDecision } from '../server/project-setup.ts'
import { projectSkills } from '../server/skills.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

it('keeps trust, definitions, presets, extensions and credentials independent of the state directory', async () => {
  const root = await temp('ultimate-workspace-config-')
  const source = join(root, 'source')
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user')
  const agentDir = join(root, 'provider')
  for (const path of [source, workspace, userHome, agentDir]) await mkdir(path)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  await writeFile(join(agentDir, 'auth.json'), '{}\n')
  const credentials = await readFile(join(agentDir, 'auth.json'))
  const put = async (path: string, name: string, content: string) => {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, name), content)
  }
  await put(
    join(source, 'agents'),
    'helper.md',
    '---\nname: helper\ndescription: Helper\n---\nBase instructions.\n',
  )
  await put(
    join(userHome, '.ultimate/agents'),
    'helper.md',
    '---\nname: helper\naddTools: []\n---\nUser instructions.\n',
  )
  await put(
    join(workspace, '.ultimate/agents'),
    'helper.md',
    '---\nname: helper\naddTools: []\n---\nWorkspace instructions.\n',
  )
  await put(
    join(userHome, '.ultimate/extensions/user-tools'),
    'server.ts',
    "export default { name: 'user-tools' }\n",
  )
  await put(
    join(workspace, '.ultimate/extensions/workspace-tools'),
    'server.ts',
    "export default { name: 'workspace-tools' }\n",
  )
  await put(
    join(workspace, '.ultimate/skills/workspace-skill'),
    'SKILL.md',
    '---\nname: workspace-skill\ndescription: A workspace skill\n---\nUse this skill.\n',
  )
  await writeFile(
    join(workspace, '.ultimate/settings.json'),
    JSON.stringify({ modelFamilies: { families: { team: { model: 'faux/faux-1' } } } }),
  )
  await writeFamilies(userHome, workspace, { families: { personal: { model: 'faux/faux-1' } } })
  const familyBytes = await readFile(familiesPath(userHome))
  const hosts = await Promise.all(
    ['state-a', 'state-b'].map((name) =>
      prepareHarness({
        ultimateRoot: source,
        projectRoot: workspace,
        userHome,
        home: join(root, name),
        faux: fauxProvider(),
      }),
    ),
  )
  const inspect = async (host: (typeof hosts)[number]) => ({
    extensions: (await discoverExtensions(host.ultimateRoot, host.projectRoot, host.userHome))
      .map((entry) => entry.name)
      .toSorted(),
    instructions: (
      await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
    ).definitions.find((definition) => definition.name === 'helper')?.instructions,
    families: (await readFamilies(host.userHome, host.projectRoot)).families,
    skills: projectSkills(host, host.projectRoot, []).skills.map((skill) => skill.name),
    trust: projectDecision(host.projectRoot, host.userHome),
  })
  const before = await Promise.all(hosts.map(inspect))
  expect(before[0]).toEqual(before[1])
  expect(before[0].trust).toBeNull()
  expect(before[0].extensions).toContain('user-tools')
  expect(before[0].extensions).not.toContain('workspace-tools')
  expect(before[0].instructions).toContain('User instructions.')
  expect(before[0].instructions).not.toContain('Workspace instructions.')
  expect(before[0].families.personal.model).toBe('faux/faux-1')
  expect(before[0].families).not.toHaveProperty('team')
  expect(before[0].skills).not.toContain('workspace-skill')

  new ProjectTrustStore(join(userHome, '.ultimate')).set(workspace, true)
  const after = await Promise.all(hosts.map(inspect))
  expect(after[0]).toEqual(after[1])
  expect(after[0].trust).toBe(true)
  expect(after[0].extensions).toContain('workspace-tools')
  expect(after[0].instructions).toContain('Workspace instructions.')
  expect(after[0].families.personal.model).toBe('faux/faux-1')
  expect(after[0].families.team.model).toBe('faux/faux-1')
  expect(after[0].skills).toContain('workspace-skill')
  expect(await readFile(familiesPath(userHome))).toEqual(familyBytes)
  expect(await readFile(join(agentDir, 'auth.json'))).toEqual(credentials)
  for (const host of hosts) {
    await expect(readFile(join(host.home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(host.home, '.ultimate/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }
})

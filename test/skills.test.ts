import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { expandSkillCommand, projectSkills } from '../server/skills.ts'
import { skillInfo } from '../server/system.ts'
import { removeTemp, temp } from './helpers.ts'

let home: string
afterEach(() => removeTemp(home))

async function skill(path: string, frontmatter: string, body = 'Do the thing.') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`)
}

async function setup() {
  home = await temp()
  const host = {
    ultimateRoot: join(home, 'clone'),
    projectRoot: join(home, 'project'),
    userHome: join(home, 'user'),
  }
  await mkdir(host.projectRoot, { recursive: true })
  // The installed application's own skills/ folder is not a skill source: skills come from extensions.
  await skill(
    join(host.ultimateRoot, 'skills/installed/SKILL.md'),
    'name: installed\ndescription: Installed folder skill',
  )
  await skill(
    join(host.ultimateRoot, 'extensions/shipping/skills/ship/SKILL.md'),
    'name: ship\ndescription: Extension ship',
  )
  await skill(
    join(host.userHome, '.ultimate/skills/ship/SKILL.md'),
    'name: ship\ndescription: User ship',
  )
  // The personal Agent Skills folder belongs to other agents and is never read.
  await skill(
    join(host.userHome, '.agents/skills/shared/SKILL.md'),
    'name: shared\ndescription: Personal Agent Skills folder',
  )
  await skill(
    join(host.projectRoot, '.agents/skills/team/SKILL.md'),
    'name: team\ndescription: Team skill\ndisable-model-invocation: true',
  )
  await skill(join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'), 'name: broken')
  return host
}

const extensions = (host: { ultimateRoot: string }, enabled = true) => [
  {
    name: 'shipping',
    path: join(host.ultimateRoot, 'extensions/shipping'),
    enabled,
    source: 'builtin' as const,
  },
]

it('loads every scope, lets later scopes override and keeps Pi diagnostics', async () => {
  const host = await setup()
  const untrusted = skillInfo(projectSkills(host, host.projectRoot, extensions(host)))
  // The project's .agents and .ultimate skills wait for the project to be trusted.
  expect(untrusted.skills.map((s) => [s.name, s.scope, s.description])).toEqual([
    ['ship', 'user', 'User ship'],
  ])
  expect(untrusted.skills[0]?.overrides).toEqual([
    join(host.ultimateRoot, 'extensions/shipping/skills/ship/SKILL.md'),
  ])
  expect(untrusted.skillDiagnostics).toEqual([])

  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  const trusted = skillInfo(projectSkills(host, host.projectRoot, extensions(host)))
  expect(trusted.skills.find((s) => s.name === 'team')).toMatchObject({
    scope: 'project',
    manual: true,
  })
  expect(trusted.skills.some((s) => s.name === 'broken' || s.name === 'shared')).toBe(false)
  expect(trusted.skillDiagnostics).toEqual([
    {
      type: 'warning',
      message: 'description is required',
      path: join(host.projectRoot, '.ultimate/skills/broken/SKILL.md'),
    },
  ])
})

it('expands /skill:name args as Pi does and leaves anything else alone', async () => {
  const host = await setup()
  const { skills } = projectSkills(host, host.projectRoot, extensions(host))
  const path = join(host.userHome, '.ultimate/skills/ship/SKILL.md')
  expect(expandSkillCommand('/skill:ship  to staging ', skills)).toBe(
    `<skill name="ship" location="${path}">\nReferences are relative to ${dirname(path)}.\n\nDo the thing.\n</skill>\n\nto staging`,
  )
  expect(expandSkillCommand('/skill:ship', skills)).toMatch(/<\/skill>$/)
  expect(expandSkillCommand('/skill:unknown go', skills)).toBe('/skill:unknown go')
  expect(expandSkillCommand('please /skill:ship', skills)).toBe('please /skill:ship')
})

it('loads enabled extensions in order below user and workspace skills, and nothing from a disabled one', async () => {
  const host = await setup()
  const folder = (name: string) => join(host.ultimateRoot, 'extensions', name)
  for (const [owner, name] of [
    ['alpha', 'shared'],
    ['alpha', 'alpha-only'],
    ['beta', 'shared'],
    ['off', 'off-only'],
    ['alpha', 'team'],
  ])
    await skill(
      join(folder(owner), 'skills', name, 'SKILL.md'),
      `name: ${name}\ndescription: ${owner} ${name}`,
    )
  // A facet's load priority can reverse host order; skill precedence follows discovery, like agent definitions.
  const owners = [
    { name: 'beta', path: folder('beta'), enabled: true, source: 'builtin' as const },
    { name: 'alpha', path: folder('alpha'), enabled: true, source: 'builtin' as const },
    { name: 'off', path: folder('off'), enabled: false, source: 'builtin' as const },
  ]
  new ProjectTrustStore(join(host.userHome, '.ultimate')).set(host.projectRoot, true)
  const { skills } = skillInfo(projectSkills(host, host.projectRoot, owners))
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]))
  expect(Object.keys(byName).toSorted()).toEqual(['alpha-only', 'shared', 'ship', 'team'])
  // The later extension wins a name, and Info names the hidden file.
  expect(byName.shared).toMatchObject({
    scope: 'extension',
    extension: 'beta',
    description: 'beta shared',
    overrides: [join(folder('alpha'), 'skills/shared/SKILL.md')],
  })
  expect(byName['alpha-only']).toMatchObject({ scope: 'extension', extension: 'alpha' })
  // A trusted workspace skill replaces an extension skill of the same name.
  expect(byName.team).toMatchObject({
    scope: 'project',
    overrides: [join(folder('alpha'), 'skills/team/SKILL.md')],
  })
  expect(byName.team).not.toHaveProperty('extension')
  // Without enabled extensions, the same host lists only its user and workspace skills.
  const none = skillInfo(projectSkills(host, host.projectRoot, [])).skills.map((s) => s.name)
  expect(none.toSorted()).toEqual(['ship', 'team'])
  expect(
    skillInfo(projectSkills(host, host.projectRoot, extensions(host, false))).skills.find(
      (s) => s.name === 'ship',
    ),
  ).toMatchObject({ scope: 'user', overrides: [] })
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { compareExtensions } from './discovery.ts'
import { loadSkills, stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Skill } from '@earendil-works/pi-coding-agent'
import type { ExtensionInfo } from '../shared/protocol.ts'

export type SkillScope = 'extension' | 'user' | 'project'

/**
 * A loaded skill with where it came from (`extension` names the owner of an extension skill), and the paths of
 * same-named skills it overrides in earlier scopes.
 */
export type ScopedSkill = Skill & { scope: SkillScope; extension?: string; overrides: string[] }

/** An extension whose `skills/` folder can supply skills; only an enabled one does. */
export type SkillOwner = Pick<ExtensionInfo, 'name' | 'path' | 'enabled' | 'source'>

/**
 * Skills from the enabled `extensions`' `skills/` folders in discovery order, the working directory's `.pi/skills`,
 * `~/.ultimate/skills` and, once the project is trusted, `<project>/.ultimate/skills`. A later scope overrides an
 * earlier skill of the same name (Pi keeps the first; Ultimate lets the project override the user and the user an
 * extension), so a disabled extension leaves no skill behind. Diagnostics are Pi's, per file.
 */
export function projectSkills(
  host: { projectRoot: string; userHome: string },
  cwd: string,
  extensions: readonly SkillOwner[],
) {
  // A project's `.agents/skills` (the Agent Skills folder other tools share) loads with its `.ultimate/skills`, once the
  // project is trusted. The personal `~/.agents/skills` does not: personal skills for Ultimate live in
  // `~/.ultimate/skills`.
  const trusted = useProjectSetup(host.projectRoot, host.userHome)
  const layers: { path: string; scope: SkillScope; extension?: string }[] = [
    ...extensions
      .filter((extension) => extension.enabled)
      .toSorted(compareExtensions)
      .map((extension) => ({
        path: join(extension.path, 'skills'),
        scope: 'extension' as const,
        extension: extension.name,
      })),
    { path: join(cwd, '.pi/skills'), scope: 'project' },
    { path: join(host.userHome, '.ultimate/skills'), scope: 'user' },
    ...(trusted
      ? [
          { path: join(host.projectRoot, '.agents/skills'), scope: 'project' as const },
          { path: join(host.projectRoot, '.ultimate/skills'), scope: 'project' as const },
        ]
      : []),
  ]
  const agentDir = join(host.userHome, '.ultimate')
  const byName = new Map<string, ScopedSkill>()
  const diagnostics = []
  // Most folders don't exist; Pi warns about each missing one, which says nothing here.
  for (const { path, scope, extension } of layers.filter((layer) => existsSync(layer.path))) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      const earlier = byName.get(skill.name)
      // Map order is first insertion: delete so the winner lists where its own scope puts it.
      byName.delete(skill.name)
      byName.set(skill.name, {
        ...skill,
        scope,
        ...(extension && { extension }),
        overrides: earlier ? [...earlier.overrides, earlier.filePath] : [],
      })
    }
  }
  return { skills: [...byName.values()], diagnostics }
}

/**
 * `/skill:name args` as Pi's AgentSession expands it: the skill's body in a `<skill>` block, then the arguments as the
 * request. Any other text, or an unknown skill, comes back as it was.
 */
export function expandSkillCommand(text: string, skills: readonly Skill[]) {
  // Pi upstream: @earendil-works/pi-coding-agent@1.6.0 src/core/agent-session.ts _expandSkillCommand — copied block format. Drop when Pi exports the expansion.
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const skill = match && skills.find((candidate) => candidate.name === match[1])
  if (!match || !skill) return text
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = match[2]?.trim()
  return args ? `${block}\n\n${args}` : block
}

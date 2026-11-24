import { existsSync, realpathSync, statSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@earendil-works/pi-durable'

/** Installation policy for the key shared by project trust and saved presets. It does not grant trust. */
export type ProjectIdentity = (canonicalDirectory: string) => string

/** Load the installation policy before any project settings or extensions are read. */
export async function loadProjectIdentity(
  ultimateRoot: string,
): Promise<ProjectIdentity | undefined> {
  const root = realpathSync(ultimateRoot)
  const inside = (file: string) => {
    const path = realpathSync(file)
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new Error(`${file} is outside the Ultimate installation`)
    return path
  }
  const manifest = join(root, 'ultimate-startup.json')
  try {
    await lstat(manifest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const config: unknown = JSON.parse(await readFile(inside(manifest), 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`${manifest}: expected an object`)
  if (!('projectIdentity' in config)) return undefined
  const file = config.projectIdentity
  if (typeof file !== 'string' || !file.trim() || isAbsolute(file))
    throw new Error(`${manifest}: projectIdentity must be a relative module path`)
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(inside(resolve(root, file))).href
    )) as {
      default?: unknown
    }
    if (typeof module.default !== 'function') throw new Error('expected a default function')
    return module.default as ProjectIdentity
  } catch (error) {
    throw new Error(`${manifest}: cannot load projectIdentity ${file}: ${String(error)}`, {
      cause: error,
    })
  }
}

/** The one policy used for project trust and preset keys in this host. */
export function createProjectAccess(
  projectRoot: string,
  userHome = homedir(),
  identify?: ProjectIdentity,
) {
  const store = () => new ProjectTrustStore(join(userHome, '.ultimate'))
  const key = () => {
    const root = realpathSync(resolve(projectRoot))
    if (!identify) return root
    const result = identify(root)
    if (
      typeof result !== 'string' ||
      !isAbsolute(result) ||
      realpathSync(result) !== result ||
      !statSync(result).isDirectory()
    )
      throw new Error(`Project identity for ${root} must be a canonical directory`)
    return result
  }
  const read = () => {
    try {
      const root = key()
      const entry = store().getEntry(root)
      return { decision: entry?.path === root ? entry.decision : null }
    } catch (error) {
      return { decision: null, error: String(error) }
    }
  }
  return {
    key,
    decision: () => read().decision,
    trusted: () => read().decision === true,
    diagnostics: () => {
      const { error } = read()
      return error ? [error] : []
    },
    setDecision: (local: boolean) => store().set(key(), local),
  }
}
export type ProjectAccess = Pick<
  ReturnType<typeof createProjectAccess>,
  'key' | 'decision' | 'trusted'
>

export function projectDecision(projectRoot: string, userHome?: string) {
  return createProjectAccess(projectRoot, userHome).decision()
}

export async function projectSettings(
  projectRoot: string,
  userHome: string,
  report: (message: string) => void = () => {},
  access: ProjectAccess = createProjectAccess(projectRoot, userHome),
): Promise<JsonObject> {
  if (!access.trusted()) return {}
  const path = join(projectRoot, '.ultimate/settings.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Project settings must be a JSON object')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(String(error))
    return {}
  }
}

export async function projectSetup(
  projectRoot: string,
  userHome?: string,
  access: ProjectAccess = createProjectAccess(projectRoot, userHome),
) {
  const root = join(projectRoot, '.ultimate')
  const config = ['extensions', 'agents', 'skills', 'settings.json'].some((name) =>
    existsSync(join(root, name)),
  )
  const readme = await readFile(join(root, 'README.md'), 'utf8').then(
    (text) =>
      Array.from(text)
        .slice(0, 16 * 1024)
        .join(''),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  return { config, decision: access.decision(), ...(readme ? { readme } : {}) }
}

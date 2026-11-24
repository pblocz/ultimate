import { stat } from 'node:fs/promises'
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  platform,
  release,
  totalmem,
  userInfo,
} from 'node:os'
import { relative, basename, join } from 'node:path'
import { projectSkills } from './skills.ts'
import { projectSetup, projectSettings } from './project-setup.ts'
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent'
import type { ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { Watch } from './extensions.ts'
import type { PreparedHost } from './harness.ts'
import { watchRoots } from './watch-roots.ts'
import type { SourceStatusApi } from '../shared/source-status.ts'

/** The skills the Info tab lists, with their scope and overrides, and Pi's load diagnostics as text. */
export function skillInfo({
  skills,
  diagnostics,
}: ReturnType<typeof projectSkills>): Pick<SystemInfo, 'skills' | 'skillDiagnostics'> {
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      scope: skill.scope,
      ...(skill.extension && { extension: skill.extension }),
      overrides: skill.overrides,
      ...(skill.disableModelInvocation && { manual: true as const }),
    })),
    skillDiagnostics: diagnostics.map((diagnostic) => ({
      type: diagnostic.type,
      message: diagnostic.message,
      ...(diagnostic.path && { path: diagnostic.path }),
    })),
  }
}
async function bytes(path: string) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
export async function createSystem(
  host: PreparedHost,
  watchRepo: Watch,
  /** The web channel's URL; absent while no web channel listens. */
  url: () => string | undefined,
  registry: (() => ExtensionInfo[]) & { diagnostics: () => Promise<string[]> },
  emit: (info: SystemInfo) => void,
  notice: (message: string) => void = () => {},
  processInfo: { activationError?: string } = {},
  origins: () => string[] = () => [],
  web: () => SystemInfo['web'] = () => ({ id: '', changed: [] }),
  sourceStatusProvider: () => (typeof SourceStatusApi)['service'] = () => undefined,
) {
  const startedAt = new Date().toISOString()
  let coreStale = false
  let code: SystemInfo['code'] = {
    ultimateRoot: host.ultimateRoot,
    branch: '',
    sha: '',
    dirty: false,
  }
  let value: SystemInfo
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSourceRefresh = 0
  let sourceProvider: ReturnType<typeof sourceStatusProvider>
  let closed = false
  let chain = Promise.resolve()
  const reportError = (error: unknown) => notice(`System refresh failed: ${String(error)}`)
  async function refresh(recheckSource = false) {
    const provider = sourceStatusProvider()
    if (recheckSource || provider !== sourceProvider) {
      sourceProvider = provider
      const status = await provider?.read().catch((error: unknown) => {
        notice(`Source status unavailable: ${String(error)}`)
        return undefined
      })
      code = {
        ultimateRoot: host.ultimateRoot,
        branch: '',
        sha: '',
        dirty: false,
        ...status,
        sourceAvailable: status !== undefined,
        coreStale,
      }
      lastSourceRefresh = Date.now()
    }
    const cpu = cpus()
    let settingsError: string | undefined
    const settings = await projectSettings(
      host.projectRoot,
      host.userHome,
      (message) => {
        settingsError = message
        notice(message)
      },
      host.projectAccess,
    )
    value = {
      build: host.build(),
      project: {
        root: host.projectRoot,
        name: basename(host.projectRoot),
        ...(await projectSetup(host.projectRoot, host.userHome, host.projectAccess)),
        settings,
        ...(settingsError ? { settingsError } : {}),
      },
      machine: {
        hostname: hostname(),
        home: homedir(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpu[0]?.model ?? '',
        cpuCount: cpu.length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        user: userInfo().username,
      },
      process: {
        pid: process.pid,
        node: process.version,
        startedAt,
        generation: Number(process.env.ULTIMATE_GENERATION ?? 1),
        ...(processInfo.activationError ? { activationError: processInfo.activationError } : {}),
        ...(url() ? { url: url() } : {}),
      },
      access: { origins: origins() },
      persistence: {
        kind: 'sqlite',
        path: host.database,
        sizeBytes: await bytes(host.database),
        walBytes: await bytes(host.database + '-wal'),
      },
      execution: { kind: 'node-local', defaultCwd: host.projectRoot },
      code,
      web: web(),
      extensions: registry(),
      extensionDiagnostics: await registry.diagnostics(),
      ...skillInfo(projectSkills(host, host.projectRoot, registry())),
      contextFiles: loadProjectContextFiles({
        cwd: host.projectRoot,
        agentDir: join(host.userHome, '.ultimate'),
      }).map((file) => file.path),
    }
    // Free memory and database sizes change all the time: new streams get them fresh, but alone they broadcast nothing,
    // since every tab re-renders whatever reads the system info on each broadcast.
    const json = JSON.stringify({
      ...value,
      machine: { ...value.machine, freeMemory: 0 },
      persistence: { ...value.persistence, sizeBytes: 0, walBytes: 0 },
    })
    if (json !== previous) {
      previous = json
      emit(value)
    }
  }
  const changed = () => {
    if (!closed) chain = chain.then(() => refresh()).catch(reportError)
    return chain
  }
  const secrets = join(host.userHome, '.ultimate/secrets.json')
  const schedule = (_event?: string, path?: string | null) => {
    if (path === secrets) {
      // This process rebuilds diagnostics from the current secret metadata on open.
      void changed().catch(reportError)
      return
    }
    if (path && /^(server|shared)\//.test(relative(host.ultimateRoot, path))) {
      coreStale = true
      code.coreStale = true
    }
    if (closed || timer) return
    timer = setTimeout(
      () => {
        timer = undefined
        chain = chain.then(() => refresh(true)).catch(reportError)
      },
      Math.max(100, 2000 - (Date.now() - lastSourceRefresh)),
    )
  }
  // Do not watch the storage home. It changes with every conversation update, but the system feed does not need those changes.
  const unwatch = watchRepo((watcher) => {
    watcher.add([
      host.ultimateRoot,
      join(host.projectRoot, '.ultimate'),
      join(host.userHome, '.ultimate/extensions'),
      join(host.userHome, '.ultimate/skills'),
      secrets,
      join(host.projectRoot, '.agents/skills'),
      join(host.projectRoot, '.pi/skills'),
    ])
    const stopRoots = watchRoots([join(host.projectRoot, '.ultimate')], (root) => {
      watcher.add(root)
      schedule()
    })
    watcher.on('all', schedule)
    return () => {
      stopRoots()
      watcher.off('all', schedule)
    }
  })
  await refresh(true)
  return {
    current: () => value,
    changed,
    async close() {
      closed = true
      clearTimeout(timer)
      unwatch()
      await chain
    },
  }
}

/** Shared record reads, paths, and the existing process state. No script factory loads here. */
import { basename, join } from 'node:path'
import type { Agent } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import type { AgentDefinition } from '@ultimate/lib/agents.ts'
import { FIRST_CHAPTER } from '@ultimate/lib/chapters.ts'
import type { Group, GroupProcess } from '@ultimate/lib/process-group.ts'
import type { Automations as Ledger } from './server.ts'
import type { Automation, Manifest, Subscriber } from './types.ts'
import { isId } from './types.ts'

export type Prepared = {
  profile?: AgentDefinition
  parent?: Agent
  slug?: string
  target?: number
  subscriber?: Subscriber
  subscribers?: Subscriber[]
  manifest?: Manifest
  manifestTarget?: Subscriber
  previousAsk?: string
  keyed?: boolean
}
export type ScriptProcess = {
  child: GroupProcess
  group: Group
  active: boolean
  afterFire: boolean
  done?: string
  queue: Promise<void>
  cleanup?: Promise<void>
  error?: string
  finished?: boolean
  stopped?: 'pause' | 'restart' | 'shutdown'
}

/** Preserve only process state across reloads, never factory functions or native task definitions. */
export const supervisorState = (host: ExtensionHost) =>
  host.resource('automations.supervisor.state', () => ({
    runs: new Map<string, ScriptProcess>(),
    launches: new Set<Promise<void>>(),
    effects: new Map<string, Promise<void>>(),
    closing: false,
  }))

export const scriptsRoot = (host: ExtensionHost) =>
  join(
    host.userHome,
    '.ultimate/automations',
    host.chapter.name === FIRST_CHAPTER
      ? basename(host.home)
      : `${basename(host.home)}@${host.chapter.name}`,
  )
export const scriptFolder = (host: ExtensionHost, id: string) => join(scriptsRoot(host), id)
export const projectDirectory = (host: ExtensionHost, id: string) =>
  join(host.projectRoot, '.ultimate/automations', id)
export const runPath = (host: ExtensionHost, sub: Pick<Automation, 'id' | 'scope'>) =>
  join(sub.scope === 'project' ? projectDirectory(host, sub.id) : scriptFolder(host, sub.id), 'run')
export const MANIFEST = 'automation.json'

export function validId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('id is required')
  const id = value.trim()
  if (!isId(id)) throw new Error('id must be A<n> or a project automation slug')
  return id
}
export async function automationRecord(host: ExtensionHost, ledger: typeof Ledger, id: string) {
  const sub = (await host.harness().snapshot(ledger, BACKGROUND_CONTEXT))?.automations[id]
  if (!sub) throw new Error(`Unknown automation: ${id}`)
  return sub
}

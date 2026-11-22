import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from '@ultimate/lib/settings.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { SubagentsWorkflow } from './api.ts'
import type { DestinationAddress } from './refs.ts'

/** Validate the shape before rejecting unsupported delivery. Do not look up or open a conversation. */
export function destinationAddress(value: unknown): DestinationAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('destination must be an object')
  const d = value as Record<string, unknown>
  if (d.kind === 'channel') {
    for (const key of [
      'channel',
      'instanceId',
      'address',
      ...(d.threadId === undefined ? [] : ['threadId']),
    ]) {
      const field = d[key]
      if (typeof field !== 'string' || !field.trim())
        throw new Error(`destination.${key} must be a non-empty string`)
    }
    throw new Error(
      `Channel delivery is not supported (${String(d.channel)}/${String(d.instanceId)})`,
    )
  }
  if (d.kind !== 'conversation') throw new Error('destination.kind must be conversation or channel')
  const address =
    typeof d.address === 'string' && /^#[1-9]\d*$/.test(d.address)
      ? Number(d.address.slice(1))
      : d.address
  if (typeof address === 'number' && Number.isSafeInteger(address) && address > 0) return address
  if (typeof address === 'string' && /^@[a-zA-Z0-9_-]+$/.test(address)) return address
  throw new Error('destination.address must be a positive conversation ID, #id or @name')
}

/** Read the current settings at use. A bad explicit setting must not route to a different recipient. */
export function defaultDestination(
  host: Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice' | 'want'>,
) {
  let previousWarning: string | undefined
  return async (): Promise<DestinationAddress | undefined> => {
    const project = await host.projectSettings()
    const settings: JsonObject = Object.hasOwn(project, 'defaultDestination')
      ? project
      : await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
    if (!Object.hasOwn(settings, 'defaultDestination')) {
      previousWarning = undefined
      const coordinator = host.want(SubagentsWorkflow)?.coordinatorName?.()
      return coordinator && `@${coordinator}`
    }
    try {
      const address = destinationAddress(settings.defaultDestination)
      previousWarning = undefined
      return address
    } catch (error) {
      const warning = `defaultDestination: ${String(error)}`
      if (warning !== previousWarning) host.notice(warning)
      previousWarning = warning
      return undefined
    }
  }
}

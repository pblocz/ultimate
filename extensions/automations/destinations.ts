/** Destination checks belong to automations; no channel sender or global routing service is installed here. */
import { int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import type { Subscriber } from './types.ts'
import { STANDING } from './types.ts'

export const destinationSchema = union([
  obj({ kind: lit('conversation'), address: union([int({ minimum: 1 }), str()]) }),
  obj({
    kind: lit('channel'),
    channel: str(),
    instanceId: str(),
    address: str(),
    threadId: opt(str()),
  }),
])

/** Check the shape before reporting unsupported delivery, without resolving names or changing state. */
export function destinationAddress(value: unknown): Subscriber {
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
  if (typeof address === 'string' && STANDING.test(address)) return address
  throw new Error('destination.address must be a positive conversation ID, #id or @name')
}

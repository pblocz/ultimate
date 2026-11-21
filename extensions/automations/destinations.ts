/** The automation tool accepts both destination shapes. Subagents validates and normalizes the address. */
import { int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'

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

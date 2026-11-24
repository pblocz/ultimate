/**
 * The patched pi-claude-code relay, for tests outside this extension. This extension owns the dependency, so other
 * extensions' tests reach it through this file instead of an install of their own.
 */
export { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'
export type { RelayExchange } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

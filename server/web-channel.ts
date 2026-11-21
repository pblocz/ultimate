/**
 * What an optional web channel needs from the runtime beyond `ChannelHost`. The core implements it and imports no web
 * code; the `web` extension starts its own listener with it, and nothing listens when that extension is off.
 */
import type { ServerEvents, SystemInfo } from '../shared/protocol.ts'
import type { ConversationBackend } from './conversation-host.ts'
import type { Extensions, Watch } from './extensions.ts'
import type { Access } from './request-security.ts'

/** The runtime's broadcast of shared state: each listener gets every system, conversation, task and notice change. */
export class Events {
  readonly listeners = new Set<
    (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents]) => void
  >()
  emit<K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) {
    for (const listener of this.listeners) listener(name, data)
  }
}

export interface WebChannelRuntime {
  events: Events
  /** The loaded extensions: browser action dispatch, which may call user-only actions, and build preparation. */
  extensions(): Extensions
  /** Origins and identity checks that admit requests beyond loopback. */
  access: Access
  /** Watch the sources through the runtime's file watcher. */
  watch: Watch
  /** The conversation backend of the open activation; throws `unavailable` while storage is closed. */
  backend(): ConversationBackend
  /** The port to bind first, and whether a taken port moves on to the next one (supervised, no port requested). */
  port: { first: number; scan: boolean }
  /** Publish the bound URL in system info and to the supervisor, or withdraw it with `undefined`. */
  endpoint(url: string | undefined): void
  /** Publish the bundle state and its rebuild, which a settings reload awaits; `undefined` withdraws them. */
  bundle(web: { info(): SystemInfo['web']; rebuild(): Promise<void> } | undefined): void
}

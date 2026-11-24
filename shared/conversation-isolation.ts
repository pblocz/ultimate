import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from './extension-api.ts'

/** An optional isolation backend for ordinary conversations. The host passes the persona's mode as data. */
export type ConversationIsolation = {
  /** Whether this backend can isolate a conversation in `mode`. The host never asks for `none`. */
  supports(mode: string): boolean
  /** Whether the conversation already has an isolate. A failure fails the caller's operation. */
  exists(id: ConversationId, caller: Context): Promise<boolean>
  /**
   * Record the isolate's preparation in the caller's Pi Durable transaction, with the conversation's creation and
   * configuration. A throw rolls the whole transaction back. Real work, such as a checkout, runs after the commit.
   */
  prepare(
    tx: Tx,
    id: ConversationId,
    input: { mode: string; cwd: string; instructions: string },
  ): Promise<void>
}

/** The host resolves this service for each public mutation, so a facet reload takes effect at once. */
export const ConversationIsolationApi = defineApi<ConversationIsolation>()(
  'ultimate.conversation-isolation',
)

import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { AgentDefinition } from '../lib/agents.ts'
import { ChannelError } from './channel-host.ts'
import { defineApi } from './extension-api.ts'

export type PersonaApplicationInput = (
  | { kind: 'chat-create' | 'chat-configure' }
  | { kind: 'child-start'; adhoc: boolean }
) & {
  /** The selected definition, including the effective tools for an ad hoc child. */
  definition: AgentDefinition | undefined
  cwd: string
  instructions: string
  /** The explicit launch override or the definition's setting. Omission leaves defaults to the provider. */
  requirement?: string
}

export type PersonaApplicationService = {
  /** Can this provider honor the named requirement? `none` needs no provider. */
  accepts(requirement: string): boolean
  /** Apply policy in the caller's transaction. A result is a note to the caller; a throw rejects the application. */
  apply(
    tx: Tx,
    id: ConversationId,
    input: PersonaApplicationInput,
    caller: Context,
  ): Promise<string | void>
  /** Decorate refreshed instructions without applying a new persona or creating resources. */
  refreshInstructions?(tx: Tx, id: ConversationId, instructions: string): Promise<string>
  /** Wait for provider-owned preparation before a channel admits input. Runs outside the write transaction. */
  beforeSubmit?(id: ConversationId, caller: Context): Promise<void>
}

export const PersonaApplication = defineApi<PersonaApplicationService>()(
  'ultimate.persona-application',
)

/** Refuse an explicit requirement before a caller starts writing. */
export function checkPersonaRequirement(
  provider: PersonaApplicationService | undefined,
  requirement: string | undefined,
) {
  if (requirement === undefined || requirement === 'none' || provider?.accepts(requirement)) return
  throw new ChannelError(
    'unavailable',
    `${requirement.charAt(0).toUpperCase()}${requirement.slice(1)} isolation is not available`,
  )
}

/** Apply the existing agent definition mechanism to ordinary conversations, without creating a resident or child. */
import { configure } from '@earendil-works/pi-durable'
import type { Agent, ConversationId, Tx } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { discoverAgents, definitionAgent, definitionFamily } from '../lib/agents.ts'
import { Family, Profile } from '../shared/conversation-configuration.ts'
import { ChannelError } from '../shared/channel-host.ts'
import type { PreparedHost } from './harness.ts'

type DefinitionHost = Pick<
  PreparedHost,
  'ultimateRoot' | 'projectRoot' | 'userHome' | 'modelRuntime'
>

/** Existing optional conversation operations, resolved from the extension host for each public mutation. */
export type ConfigurationServices = {
  isolation?: {
    get(id: ConversationId, ctx: Context): Promise<{ path: string; state: string } | undefined>
    prepare(tx: Tx, id: ConversationId, input: { cwd: string; instructions: string }): Promise<void>
  }
  summaries?: (tx: Tx, id: ConversationId, enabled: boolean) => Promise<void>
}

/** Resolve before the mutation transaction, using the same discovery, overlays, and model overrides as child agents. */
export async function prepareDefinition(
  host: DefinitionHost,
  base: Agent,
  name: string | null,
  overrides: Parameters<typeof definitionAgent>[3] = {},
) {
  if (name !== null && (typeof name !== 'string' || !name.trim()))
    throw new ChannelError('invalid_input', 'Expected definition name')
  const discovered =
    name === null
      ? undefined
      : await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
  const definition = discovered?.definitions.find((candidate) => candidate.name === name)
  if (name !== null && !definition)
    throw new ChannelError('invalid_input', `Unknown agent definition: ${name}`)
  const change = definitionAgent(definition, base, host.modelRuntime, overrides)
  return {
    definition,
    change,
    family: overrides.model ? null : definitionFamily(definition, change),
    isolate: definition?.isolate ?? 'none',
  }
}

/** Persist selection and effective fields together. Optional workspace/summary effects use their existing services. */
export async function applyDefinition(
  tx: Tx,
  id: ConversationId,
  prepared: Awaited<ReturnType<typeof prepareDefinition>>,
) {
  await configure(tx, id, prepared.change)
  const profile = await tx.doc(Profile, id)
  if (prepared.definition) profile.definition = prepared.definition.name
  else delete profile.definition
  delete profile.adhoc
  ;(await tx.doc(Family, id)).name = prepared.family
}

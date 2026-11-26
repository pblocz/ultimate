/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents and
 * talking to the primary one, and the agent definitions.
 */
import { WandSparklesIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, definePoint, events, useAction, useConversations, useDocOf } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import {
  CoordinatorDoc,
  DefaultDestinationAction,
  OpenCoordinatorAction,
  RunsDoc,
  StandingAction,
  StandingDoc,
} from './refs.ts'
import type { Run } from './refs.ts'

export {
  ClearConversationAction,
  CoordinatorDoc,
  DefaultDestinationAction,
  OpenCoordinatorAction,
  DefinitionAction,
  DefinitionsAction,
  ProfileDoc,
  StandingAction,
  StandingDoc,
} from './refs.ts'
export { Tag } from './parts.tsx'

/** A badge on a child's call card, by the child's id (workspaces shows its worktree). Nothing while nothing provides it. */
export const ChildBadge = definePoint<number, ReactNode>('subagents.child-badge')
/**
 * The result of a `subagent` call's `land` or `discard` action (workspaces renders what landed). Undefined shows the
 * plain output.
 */
export const ChildResult = definePoint<{ action: string; output: string }, ReactNode | undefined>(
  'subagents.child-result',
)

/** What child `id` was started on, its model id and whether it was made on the fly; undefined for other conversations. */
export function useRun(id: number | undefined): Run | undefined {
  const runs = useDocOf(1, RunsDoc)
  return id === undefined ? undefined : runs?.[String(id)]
}

/**
 * A child's name as rows and cards show it: its label, then the model it was started on, muted, and a wand when
 * `subagent start` made it on the fly rather than from a definition.
 */
export function RunName({ id, label }: { id: number | undefined; label: ReactNode }) {
  const run = useRun(id)
  return (
    <>
      {run?.adhoc && (
        <WandSparklesIcon
          aria-label="Made on the fly"
          className="mr-1 inline size-3 shrink-0 align-[-2px] text-muted-foreground"
        >
          <title>Made on the fly, without a definition</title>
        </WandSparklesIcon>
      )}
      {label}
      {run?.model && <span className="text-muted-foreground/70"> · {run.model}</span>}
    </>
  )
}

/** The active role and its current conversation, if it has been opened. */
export function useCoordinator() {
  const name = useDocOf(1, CoordinatorDoc)?.name
  const standing = useDocOf(1, StandingDoc)
  return name ? { name, id: standing?.[name] } : undefined
}

/** Explicitly open the active coordinator's standing conversation. */
export async function talkToCoordinator(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action(OpenCoordinatorAction, null)
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** The display name and existing ID of the default. A read never opens a standing agent. */
export function useDefaultConversation() {
  const { data } = useAction(DefaultDestinationAction, null, { onError: () => {} })
  const standing = useDocOf(1, StandingDoc)
  const conversations = useConversations()
  const address = data?.address
  const name = typeof address === 'string' ? address.slice(1) : undefined
  const id =
    typeof address === 'number'
      ? address
      : name && standing && Object.hasOwn(standing, name)
        ? standing[name]
        : undefined
  return {
    address,
    id,
    label:
      typeof address === 'string'
        ? address
        : (conversations.find((item) => item.id === id)?.title ??
          (id === undefined ? 'default conversation' : `#${id}`)),
  }
}

/** Open the configured conversation for a user action. Resolve a name only after the user requests it. */
export async function openDefaultConversation(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const { address } = await api.action(DefaultDestinationAction, null)
  if (address === undefined) return undefined
  const id =
    typeof address === 'number'
      ? address
      : await api.action(StandingAction, { name: address.slice(1) })
  actions.showSurface('agent')
  actions.switchConversation(id)
  return id
}

/** Show `source`, where an agent's message came from, with a way back to `receiver`, where it arrived. */
export function openAgentSource(
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  events.emit('subagents:source', { target: source, back: receiver })
  switchConversation(source.conversation)
}

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  ParkedRuns,
  Provided,
  useDocOf,
  useStore,
  useTasks,
  useUltimate,
  Wordmark,
} from '@/sdk'
import {
  MessagesDoc,
  conversationState,
  emptyMessages,
  stateTone,
  stateWord,
  waitingOnUser,
} from '@ultimate/ext/messages/ui.tsx'
import {
  AgentMark,
  ConversationPhase,
  useAgentTitle,
  useOverview,
} from '@ultimate/ext/conversations/ui.tsx'
import { talkToCoordinator, useCoordinator } from '@ultimate/ext/subagents/ui.tsx'

/** A busy standing agent's word: its classified phase, lower case like its idle line, else "working". */
const workingWord = (phase: { word: string; waiting: boolean } | undefined) =>
  phase && !phase.waiting ? phase.word : 'working'

/** The title bar's wordmark opens the standing coordinator. */
export function UltimateWordmark() {
  const actions = useUltimate()
  const role = useCoordinator()
  const presentation = useAgentTitle(role?.name ?? '')
  if (!role) return null
  return (
    <Wordmark
      label={`Talk to ${presentation?.title ?? `@${role.name}`}`}
      onClick={() => void talkToCoordinator(actions)}
    />
  )
}

/**
 * The title bar's way to @ultimate on phones, where the sidebar with its row is hidden: its state as its sidebar row
 * says it (`conversationState`), the mark pulsing while it works and amber while questions wait on you.
 */
export function UltimateButton() {
  return (
    <span className="contents md:hidden">
      <Provided input={null} point={ParkedRuns}>
        {(parked) => <Primary parked={parked} />}
      </Provided>
    </span>
  )
}

function Primary({ parked }: { parked?: ReadonlySet<number> }) {
  const actions = useUltimate()
  const role = useCoordinator()
  const id = role?.id
  const presentation = useAgentTitle(role?.name ?? '')
  const tasks = useTasks()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const runState = useOverview()[id ?? -1]?.runState
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const paused = id !== undefined && parked?.has(id) === true
  const working =
    id !== undefined &&
    !paused &&
    (runState === 'working' ||
      Object.values(tasks?.tasks ?? {}).some(
        (task) => !task.background && task.conversationId === id,
      ))
  const state = conversationState(
    { id: id ?? -1, kind: 'primary', runState, busy: working, parked: paused },
    log,
  )
  const waiting = waitingOnUser(log)
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  if (!role) return null
  const { name } = role
  const title = presentation?.title ?? `@${name}`
  return (
    <Provided input={working ? id : undefined} point={ConversationPhase}>
      {(phase) => {
        const word = workingWord(phase)
        const label = state === 'working' ? word : stateWord(state, waiting)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-current={active ? 'page' : undefined}
                aria-label={`Talk to ${title} (${label})`}
                className={cn(
                  'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                  active && 'text-foreground',
                )}
                data-ui="ultimate-button"
                data-ultimate-button
                onClick={() => void talkToCoordinator(actions)}
                type="button"
              >
                <AgentMark
                  name={name}
                  presence={working ? 'working' : state === 'waits' ? 'waiting' : undefined}
                  size="sm"
                />
                {title}
                {state === 'working' && word !== 'working' && (
                  <span className="text-brand">{word}</span>
                )}
                {/* The bare count: the phone bar has no room for its words, which the label carries. */}
                {(state === 'paused' || state === 'waits') && (
                  <span className={stateTone[state]}>{state === 'waits' ? waiting : 'paused'}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Talk to {title} · {label}
            </TooltipContent>
          </Tooltip>
        )
      }}
    </Provided>
  )
}

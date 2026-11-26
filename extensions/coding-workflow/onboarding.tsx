/**
 * The coding onboarding in the browser, moved from onboarding unchanged: Start here above @ultimate's composer, the
 * Git setup card and its status-line link, the start and walkthrough cards, and Walk me through Ultimate. It fills
 * onboarding's points, so Get ready and the project setup link start and ask @ultimate.
 */
import { CheckIcon, CompassIcon, GitBranchIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  attention,
  Card,
  column,
  errorMessage,
  events,
  provide,
  useAction,
  useConversation,
  useDialog,
  useDocOf,
  useEvent,
  useExtensions,
  useModels,
  useSystem,
  useTranscript,
} from '@/sdk'
import type { CommandContribution, EntryRecord, EntryRenderer, Provision } from '@/sdk'
import { MemoryDoc, useRoots } from '@ultimate/ext/lineage/ui.tsx'
import {
  DismissAction,
  firstRunDialog,
  HelpAction,
  onboarded,
  SetupCard,
  SetupLink,
  SetupWorkflow,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from '@ultimate/ext/onboarding/ui.tsx'
import { useCoordinator } from '@ultimate/ext/subagents/ui.tsx'
import { IsolationAction } from '@ultimate/ext/workspaces/ui.tsx'
import type { Isolation } from '@ultimate/ext/workspaces/refs.ts'

function useIsolation() {
  const workspaces = useExtensions().some((extension) => extension.name === 'workspaces')
  // A run may have set up Git: read again when one ends.
  const busy = useConversation((conversation) => conversation.busy)
  const [runs, setRuns] = useState({ busy, ended: 0 })
  if (busy !== runs.busy) setRuns({ busy, ended: runs.ended + (busy ? 0 : 1) })
  const isolation = useAction(IsolationAction, null, { enabled: workspaces, on: runs.ended })
  useEvent('onboarding:git', () => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (workspaces) void isolation.refetch()
  })
  return workspaces ? isolation.data : undefined
}

/** Dismissing Start here quiets the setup reminders too; ⌘K Get ready… and the Extensions panel still reach them. */
const useDismissed = () => useDocOf(1, StartsDoc)?.dismissed === true
const useOff = () => useAction(StatusAction).data?.off === true
export function NoGit() {
  const reason = useIsolation()?.reason
  const dismissed = useDismissed()
  const off = useOff()
  return reason && !dismissed && !off ? <SetupLink card="git">set up git</SetupLink> : null
}

export function GitCard({
  isolation,
  onDone,
}: {
  isolation?: Isolation
  onDone: (choice: { initialize: boolean }) => Promise<void>
}) {
  const [initializing, setInitializing] = useState<boolean>()
  // A reload after initialization must retry the same notification, not hand Git back to the agent.
  const initialize =
    initializing ?? (isolation?.empty === true || (isolation !== undefined && !isolation.reason))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const apply = async () => {
    if (busy) return
    setBusy(true)
    try {
      setInitializing(initialize)
      await onDone({ initialize })
      events.emit('onboarding:git', null)
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">{isolation?.reason}</p>
      <p className="text-sm leading-relaxed">
        With Git, each conversation gets its own checkout. Finished work lands on your branch
        through the lander, which runs your checks first. Until then, conversations share this
        folder.
      </p>
      <p className="flex gap-2 rounded-md border border-border bg-sidebar p-3 text-xs leading-relaxed text-muted-foreground">
        <GitBranchIcon className="size-4 shrink-0 text-brand" />
        {initialize
          ? 'The folder is empty, so Ultimate runs git init and makes an empty first commit.'
          : 'The folder has files. @ultimate chooses what the first commit holds, without secrets, dependencies or build output. No remote, no push.'}
      </p>
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex justify-end">
        <Button
          disabled={busy || (!isolation && initializing === undefined)}
          size="sm"
          onClick={() => void apply()}
        >
          {initialize ? 'Set up Git' : 'Let @ultimate do it'}
        </Button>
      </div>
    </div>
  )
}

/** Whether @ultimate has said anything to the user since `entry`: text, or a message call. */
const spokeSince = (transcript: readonly EntryRecord[], entry: EntryRecord) =>
  transcript.some((later) => {
    const message = later.model?.[0]
    return (
      later.id > entry.id &&
      message?.role === 'assistant' &&
      message.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'toolCall' && block.name === 'message'),
      )
    )
  })

/**
 * The start of onboarding or the walkthrough: while @ultimate prepares its first message, a card that says what is
 * happening; afterwards a quiet record of when it started.
 */
function StartCard({
  entry,
  title,
  preparing: text,
  instructions,
}: {
  entry: EntryRecord
  title: string
  /** What @ultimate is doing until its first message. */
  preparing: string
  instructions?: string
}) {
  const busy = useConversation((conversation) => conversation.busy)
  const transcript = useTranscript()
  const preparing = busy && !spokeSince(transcript, entry)
  return preparing ? (
    <Card className="flex items-start gap-3 px-4 py-3">
      <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-brand" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">Getting ready…</p>
        <p className="text-sm text-muted-foreground">{text}</p>
        {instructions && <Instructions text={instructions} />}
      </div>
    </Card>
  ) : (
    <section className="text-xs text-muted-foreground">
      <p className="flex items-center gap-2">
        <CheckIcon className="size-3.5 shrink-0 text-brand/70" />
        {title}
      </p>
      {instructions && (
        <div className="mt-1 pl-5.5">
          <Instructions text={instructions} />
        </div>
      )}
    </section>
  )
}

function Instructions({ text }: { text: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Your instructions: <span className="whitespace-pre-wrap text-foreground/85">{text}</span>
    </p>
  )
}

/** Above @ultimate's composer until onboarding has run for the project: one click starts it. */
export function StartComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const ultimate = useCoordinator()?.id
  if (id === undefined || id !== ultimate) return core
  return (
    <>
      <StartHere dock={dock} />
      {core}
    </>
  )
}

function StartHere({ dock }: { dock?: boolean }) {
  const root = useRoots()?.[0]
  const starts = useDocOf(1, StartsDoc)
  const memories = useDocOf(root ?? 1, MemoryDoc)
  const project = useSystem()?.project.name
  const status = useAction(StatusAction).data
  // @ultimate's model, as Get ready checks it: without a login and an available model, setup opens Get ready first.
  const models = useModels()
  const agent = useConversation((conversation) => conversation.agent.model)
  const ready = models?.models.some(
    (model) => model.provider === agent?.provider && model.id === agent.modelId && model.available,
  )
  const [, openGetReady] = useDialog(firstRunDialog)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  if (root === undefined || starts === undefined || memories === undefined || !status) return null
  if (status.off || starts?.dismissed || onboarded(starts?.roots[String(root)], memories))
    return null
  const run = async (action: () => Promise<unknown>) => {
    setSending(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className={`${column(dock)} pb-2`}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-lg border border-brand/30 bg-brand/5 px-3.5 py-3"
        data-onboarding-start={root}
      >
        <CompassIcon className="size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-[13.5px] font-medium text-foreground">
            Let Ultimate get familiar with {project ?? 'the project'}
          </p>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            {error ??
              '@ultimate walks you through how it works, helps you choose your setup and reads the project.'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            disabled={sending}
            onClick={() =>
              ready ? void run(() => api.action(StartAction, { root })) : openGetReady(true)
            }
          >
            {sending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <CompassIcon />}
            Set up with @ultimate
          </Button>
          <Button
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            disabled={sending}
            onClick={() => void run(() => api.action(DismissAction))}
            size="icon-sm"
            title="Not now. ⌘K Get ready… starts setup later."
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

const workflow = {
  start: async () => (await api.action(StartAction, {})).id,
  help: async (card: 'project' | 'git') => (await api.action(HelpAction, { card })).id,
}

/** The Git setup card in onboarding's `setup` tool call. */
function useGitCard({
  card,
  done,
}: {
  card: string
  done: (choice: { initialize: boolean }) => Promise<void>
}) {
  const isolation = useIsolation()
  return card === 'git' ? <GitCard isolation={isolation} onDone={done} /> : undefined
}

export const onboardingProvides: Provision[] = [
  provide(SetupWorkflow, () => (useCoordinator() ? workflow : undefined)),
  provide(SetupCard, useGitCard),
]

export const onboardingEntries: Record<string, EntryRenderer> = {
  // Marked `attention` so the start stays in @ultimate's thread instead of folding into the stretch before its first
  // message: it is all a newcomer sees while that first turn runs (#554687).
  'onboarding.start': attention(({ entry }) => (
    <StartCard
      entry={entry}
      instructions={(entry.data as { instructions?: string }).instructions}
      title="Onboarding started"
      preparing="@ultimate is reading your project. In a moment it starts a short walkthrough of how Ultimate works, with a few questions you answer here."
    />
  )),
  'walkthrough.start': attention(({ entry }) => (
    <StartCard
      entry={entry}
      title="Walkthrough started"
      preparing="@ultimate is preparing a short walkthrough of how Ultimate works, with a few questions you answer here."
    />
  )),
}

export const onboardingCommands: CommandContribution[] = [
  {
    id: 'onboarding.walkthrough',
    title: 'Walk me through Ultimate',
    run: async (context) => {
      const { id } = await api.action(WalkthroughAction)
      context.switchConversation(id)
      context.showSurface('agent')
    },
  },
]

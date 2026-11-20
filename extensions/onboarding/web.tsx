import { BlocksIcon, CheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  attention,
  Card,
  defineWebExtension,
  errorMessage,
  Provided,
  useAction,
  useConversation,
  useDialog,
  useDocOf,
  useSystem,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { FirstRun, ProjectCard, Recommended } from './pages.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { firstRunDialog, gitDialog, projectDialog } from './parts.tsx'
import { SetupCard, SetupWorkflow } from './points.tsx'
import { ChooseAction, StartsDoc, StatusAction } from './refs.ts'
import { SetupLink } from './setup-link.tsx'

function Onboarding() {
  return (
    <Provided input={null} point={SetupWorkflow}>
      {(workflow) => <Setup workflow={workflow} />}
    </Provided>
  )
}

/** Get ready, and the setup entry points: they ask the coding workflow's primary agent, when one provides help. */
function Setup({
  workflow,
}: {
  workflow:
    | { start: () => Promise<number>; help: (card: 'project' | 'git') => Promise<number> }
    | undefined
}) {
  const status = useAction(StatusAction)
  const ui = useUltimate()
  const [finished, setFinished] = useState(false)
  // The panel and start-page entry points ask @ultimate when the coding workflow is on; else the panel decides.
  const [projectOpen, setProjectOpen] = useDialog(projectDialog)
  const [gitOpen, setGitOpen] = useDialog(gitDialog)
  const [again, setAgain] = useDialog(firstRunDialog)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!projectOpen && !gitOpen) return
    setProjectOpen(false)
    setGitOpen(false)
    if (!workflow) {
      if (projectOpen) ui.openPanel('extensions')
      return
    }
    void workflow
      .help(projectOpen ? 'project' : 'git')
      .then((id) => {
        ui.switchConversation(id)
        ui.showSurface('agent')
      })
      .catch((failure) => setError(errorMessage(failure)))
  }, [projectOpen, gitOpen, setProjectOpen, setGitOpen, ui, workflow])
  return (
    <>
      <FirstRun
        open={again || (!navigator.webdriver && status.data?.firstRun === true && !finished)}
        onClosed={() => ui.focusComposer()}
        onDone={async (skipped) => {
          // Without the coding workflow, Get ready only applies the settings: no agent starts.
          if (!skipped && workflow) {
            ui.switchConversation(await workflow.start())
            ui.showSurface('agent')
          }
          setFinished(true)
          setAgain(false)
        }}
      />
      {error && (
        <div className="fixed right-4 bottom-12" role="alert">
          <button
            className="cursor-pointer rounded border border-error/40 bg-card p-3 text-left text-xs text-error"
            onClick={() => setError(undefined)}
            title="Dismiss"
            type="button"
          >
            {error}
          </button>
        </div>
      )}
    </>
  )
}

/** Dismissing Start here quiets the setup reminders too; ⌘K Get ready… and the Extensions panel still reach them. */
const useDismissed = () => useDocOf(1, StartsDoc)?.dismissed === true
const useOff = () => useAction(StatusAction).data?.off === true
function Undecided() {
  const project = useSystem()?.project
  const dismissed = useDismissed()
  // With onboarding off nothing else asks, so an undecided `.ultimate/` keeps its reminder.
  const off = useOff()
  return (off || !dismissed) && project?.config && project.decision === null ? (
    <SetupLink card="project" off={off}>
      project setup
    </SetupLink>
  ) : null
}
type Choice = { card: string; summary: string; toolCallId: string }
function SetupCall({ call }: { call: ToolCallView }) {
  const transcript = useTranscript()
  const conversationId = useConversation((conversation) => conversation.id)
  const status = useAction(StatusAction)
  const card = typeof call.args.card === 'string' ? call.args.card : ''
  const entry = transcript.find(
    (candidate) =>
      candidate.kind === 'onboarding.choice' && (candidate.data as Choice).toolCallId === call.id,
  )
  const settled = (entry?.data as Choice | undefined)?.summary
  const done = async (payload: {
    extensions?: Record<string, boolean>
    local?: boolean
    initialize?: boolean
  }) => {
    await api.action(ChooseAction, { card, ...payload, toolCallId: call.id }, { conversationId })
  }
  if (!['extensions', 'project', 'git'].includes(card)) return null
  const title =
    card === 'extensions'
      ? 'Recommended extensions'
      : card === 'project'
        ? "Use this project's setup?"
        : 'Set up Git for this folder?'
  return (
    <Card
      attention={!settled && call.status !== 'error'}
      className="overflow-hidden"
      data-setup-card={card}
    >
      <header className="border-b border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
        {title}
      </header>
      {call.status === 'error' ? (
        <p className="p-4 text-xs text-error">
          {call.diagnostics.find((item) => item.severity === 'error')?.message ?? call.output}
        </p>
      ) : settled ? (
        <p className="flex items-start gap-2 p-4 text-sm">
          <CheckIcon className="size-4 shrink-0 text-brand" />
          <span>Chosen: {settled}</span>
        </p>
      ) : call.status !== 'done' ? (
        <p className="p-4 text-xs text-muted-foreground">
          {call.status === 'interrupted'
            ? 'Setup was interrupted. Ask @ultimate to show this card again.'
            : 'Checking…'}
        </p>
      ) : card === 'extensions' ? (
        <Recommended status={status.data} onDone={done} />
      ) : card === 'project' ? (
        <ProjectCard adds={status.data?.adds} onDone={done} />
      ) : (
        <Provided input={{ card, done }} point={SetupCard}>
          {(drawn) => drawn}
        </Provided>
      )}
    </Card>
  )
}
function ChoiceCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as Choice
  return (
    <section className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-mono">Setup choice · {data.card}</span>
      <p className="mt-1 text-foreground/85">{data.summary}</p>
    </section>
  )
}

export default defineWebExtension({
  tools: { setup: attention(SetupCall) },
  entries: {
    'onboarding.choice': ChoiceCard,
  },
  slots: {
    overlay: [Onboarding],
    'statusline.right': [{ component: Undecided, phone: true }],
  },
  panels: [
    {
      id: 'extensions',
      title: 'Extensions',
      icon: BlocksIcon,
      component: ExtensionsPanel,
      order: 8,
    },
  ],
  commands: [
    {
      id: 'onboarding.extensions',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
    {
      id: 'onboarding.first-run',
      title: 'Get ready…',
      run: (context) => context.open(firstRunDialog),
    },
  ],
})

import { MessagesSquareIcon } from 'lucide-react'
import {
  Conversation,
  Header,
  Panels,
  Sidebar,
  StatusLine,
  api,
  defineWebExtension,
  ErrorReport,
  getConversation,
  getState,
  insertIntoComposer,
  provide,
  useStore,
  useUltimate,
} from '@/sdk'
import type { CommandContribution } from '@/sdk'
import { ClearConversationAction } from '../subagents/ui.tsx'
import { PanelActions } from './panel-actions.tsx'

/** The conversation in a centred column, with the sidebar and the right panel beside it. */
function Agent() {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header />
          <Conversation />
        </main>
        <Panels />
      </div>
      <StatusLine />
    </>
  )
}

/**
 * Commands for the shown conversation, on every surface; the palette lists them under Ultimate, with the shell's. A
 * shortcut pressed inside a `ConversationScope` (a side chat) acts on that conversation instead.
 */
const commands: CommandContribution[] = [
  {
    id: 'agent.stop',
    title: 'Stop the run',
    keys: 'escape',
    whileTyping: true,
    when: (context) => getConversation(context.conversationId).busy,
    run: (context) => api.abort(context.conversationId),
  },
  {
    id: 'agent.clear',
    title: 'Clear conversation',
    when: ({ conversationId }) => {
      const { requested, conversations } = getState()
      if (conversationId === undefined || conversationId === 1 || requested !== conversationId)
        return false
      const summary = conversations.find(({ id }) => id === conversationId)
      return (
        (summary?.label === 'chat' || summary?.label === 'agent') &&
        summary.parentConversationId === undefined &&
        summary.ownerTaskId === undefined
      )
    },
    run: async ({ conversationId, switchConversation }) => {
      if (conversationId === undefined || getState().requested !== conversationId) return
      const id = await api.action(
        ClearConversationAction,
        { id: conversationId },
        { conversationId },
      )
      if (getState().requested === conversationId) switchConversation(id)
    },
  },
  // Lineage replaces these two for its roots.
  {
    id: 'agent.compact',
    title: 'Compact the context',
    run: () => api.compact(),
  },
  {
    id: 'agent.composer',
    title: 'Focus the composer',
    run: (context) => context.focusComposer(),
  },
  {
    id: 'agent.main',
    title: 'Show the main conversation',
    when: (context) => context.conversationId !== 1,
    run: (context) => context.switchConversation(1),
  },
]

/**
 * An error card's report goes into the selected conversation's draft, unsent, beside what the user typed there. No
 * button without a selection. The coding workflow replaces it with @ultimate's draft.
 */
function useErrorReport() {
  const selected = useStore((state) => state.requested)
  const { focusComposer } = useUltimate()
  if (selected === undefined) return undefined
  return {
    title: 'Add to the draft',
    send: (report: string) => {
      insertIntoComposer(selected, report)
      requestAnimationFrame(focusComposer)
    },
  }
}

export default defineWebExtension({
  provides: [provide(ErrorReport, useErrorReport)],
  // After the other items, just before the command palette button.
  slots: { 'titlebar.right': [{ component: PanelActions, order: 100 }] },
  surfaces: [
    {
      id: 'agent',
      title: 'Agent',
      icon: MessagesSquareIcon,
      description: 'The conversation, with panels beside it',
      component: Agent,
    },
  ],
  commands: commands.map((command) => ({ group: 'Ultimate', ...command })),
})

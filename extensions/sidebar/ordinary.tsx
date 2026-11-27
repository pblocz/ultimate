import { PlusIcon } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { cn, formatAgo, useConversations, useNow, useStore, useUiState, useUltimate } from '@/sdk'
import { chats, landing } from './chats.ts'
import { Section } from './section.tsx'
import { useShell } from './state.tsx'

/**
 * The ordinary conversation list at the sidebar's bottom, folded under a "Conversations" header (open unless folded,
 * kept in `ext.conversations.closedSections`); the explicit New conversation action stays above the fold.
 */
export function OrdinaryConversations() {
  const list = chats(useConversations())
  const actions = useShell()
  // Beside another surface (Memory) no conversation shows, so no row is highlighted.
  const requested = useStore((state) => state.requested)
  const shownId = actions.surface === 'agent' ? requested : undefined
  const now = useNow(60_000)
  return (
    <nav
      aria-label="Ordinary conversations"
      className="flex flex-col border-t border-border/60 pt-2"
    >
      <button
        className="mx-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] text-foreground/85 outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => actions.runCommand('ultimate.new')}
        type="button"
      >
        <PlusIcon className="size-3.5 shrink-0" />
        New conversation
      </button>
      <Section count={list.length} id="conversations" label="Conversations">
        {list.length === 0 ? (
          <p className="px-4 py-1 text-[12px] text-muted-foreground">No conversations yet.</p>
        ) : (
          list.map((conversation) => {
            const shown = conversation.id === shownId
            const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
            return (
              <button
                aria-current={shown ? 'page' : undefined}
                className={cn(
                  'mx-2 flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
                )}
                data-conversation={conversation.id}
                data-ui="ordinary-row"
                key={conversation.id}
                onClick={() => actions.switchConversation(conversation.id)}
                type="button"
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    conversation.busy ? 'animate-pulse-dot bg-brand' : 'bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    conversation.title
                      ? shown
                        ? 'text-foreground'
                        : 'text-foreground/85'
                      : 'text-muted-foreground',
                  )}
                >
                  {conversation.title ?? 'Untitled conversation'}
                </span>
                {latest > 0 && (
                  <span
                    className="shrink-0 font-mono text-[10.5px] text-muted-foreground/80"
                    title={new Date(latest).toLocaleString()}
                  >
                    {formatAgo(latest, now)}
                  </span>
                )}
              </button>
            )
          })
        )}
      </Section>
    </nav>
  )
}

/** The ordinary conversations, which the coding tree leaves to this list (`Unlisted`). */
export function useChatIds(): ReadonlySet<number> {
  const conversations = useConversations()
  return useMemo(() => new Set(chats(conversations).map((chat) => chat.id)), [conversations])
}

/** With no conversation selected, open the latest ordinary one; with none, the empty new-chat screen stays. */
export function OpenLatest() {
  const loaded = useStore((state) => state.shared !== undefined)
  const [chosen] = useUiState<number | null>('shell.conversation', null)
  const conversations = useConversations()
  const { switchConversation } = useUltimate()
  const target = landing(loaded, chosen ?? undefined, conversations)
  useEffect(() => {
    if (target !== undefined) switchConversation(target, { replace: true })
  }, [target, switchConversation])
  return null
}

/** Ordinary conversations: created as chats, not branches, subagents, side chats or internal records. Browser-safe. */
import type { ConversationSummary } from '@ultimate/shared/protocol.ts'

/** A conversation the user created as a chat; the shared create operation marks it with the `chat` label. */
export const isChat = (conversation: ConversationSummary) =>
  conversation.label === 'chat' &&
  conversation.parentConversationId === undefined &&
  conversation.branchOf === undefined

const latest = (conversation: ConversationSummary) =>
  Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)

/** The ordinary conversations, the latest activity first; an empty new chat by its creation order. */
export const chats = (conversations: readonly ConversationSummary[]) =>
  conversations.filter(isChat).toSorted((a, b) => latest(b) - latest(a) || b.id - a.id)

/**
 * Where a page opens when no conversation is selected (a first load, a remembered one that is gone): the latest
 * ordinary conversation, else nothing, which shows the empty new-chat screen. It never creates or selects a primary
 * agent or the internal root.
 */
export const landing = (
  loaded: boolean,
  chosen: number | undefined,
  conversations: readonly ConversationSummary[],
): number | undefined => (loaded && chosen === undefined ? chats(conversations)[0]?.id : undefined)

/**
 * Messages: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationHandle, ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Device } from '../../shared/events.ts'
import { MessagesDoc } from './refs.ts'
import type { Question, Remote, Via } from './refs.ts'
import type { send } from './send.ts'
import type { DeliveryInput } from './delivery.ts'

/** The request a branch serves when its starter still owes an answer. */
export type Serves = { message: number; from: number | 'remote'; remote?: Remote }
/** Branch ownership and the last generation observed by its report task. Stored as before. */
export const Started = defineDoc<{ by?: number; yielded?: number; serves?: Serves }>({
  kind: 'board.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** One message as the log stores it. */
export type Message = {
  id: number
  /** `remote`: another project's Ultimate, named by `remote`. */
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'failed' | 'stopped'
  entry?: EntryId
  answer?: EntryId
  error?: string
  /** The tool call that sent it: `message`'s or `branch`'s own id, `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: EntryId; count: number }
  /** A branch's final answer routed to its starter after it stopped with nothing under way: it awaits the starter. */
  report?: true
  /** A branch's reply to its starter: it awaits the starter's answer, routed down to it. */
  awaits?: true
  /** The starter's final answer to a branch's report or reply, routed to that branch: the answer's entry. */
  routed?: EntryId
  /** A branch's report answering routed answers only: the starter's answer to it stays local. */
  echo?: true
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
  /** The questions a reply-expected message to the user asks, answered on its card. */
  questions?: Question[]
  /** A user answer or dismissal that @ultimate settled for the user, not their own click. */
  via?: Via
}
/** Every message between conversations and the user, on the root conversation. */
export const Messages = defineDoc<{ messages: Message[]; next: number }>({
  kind: MessagesDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1 }),
})

export type MessagesService = {
  /**
   * Reply `text` from the user to open message `messageId`, from browser `device`; returns the reply's message
   * id. Records a `user.input` event.
   */
  answer(
    messageId: number,
    text: string,
    ctx: Context,
    device?: Device,
    via?: { via: Via; primary: number; fromLabel: string },
  ): Promise<number>
  /**
   * The messages that wait on the user's answer, oldest first: each one's id, the conversation that asked, when, and its
   * question in one line (the line its card's header shows).
   */
  openQuestions(
    ctx: Context,
  ): Promise<{ message: number; conversation: number; at: number; text: string }[]>
  /** Close open message `messageId` unanswered; its sender gets a one-way note. Returns the note's message id. */
  dismiss(
    messageId: number,
    ctx: Context,
    device?: Device,
    settlement?: { via: Via; reason: string; fromLabel: string },
  ): Promise<number>
  /** Admit through the same receipts, address rules, image checks, and delivery task as the message tool. */
  dispatch(
    from: number | 'user',
    input: Parameters<typeof send>[2],
    ctx: Context,
    options?: Parameters<typeof send>[4],
  ): Promise<number>
  /** Append a message inside the caller's existing transaction, using the same bounded ledger. */
  append(tx: Tx, input: Omit<Message, 'id' | 'at'>): Promise<Message>
  /** Submit a trusted notification through the caller's native handle, with its original entry and receipt. */
  notify(
    conversation: Pick<ConversationHandle, 'submit'>,
    input: { text: string; requestId: string; entry: { kind: string; data: JsonValue } },
    ctx: Context,
  ): Promise<void>
  /** Register the existing native delivery in the caller's transaction. */
  deliver(tx: Tx, input: DeliveryInput): Promise<void>
  /** The direct parent that an ordinary child may message. */
  parent(id: number, ctx: Context): Promise<ConversationId | undefined>
  /** The ordinary sender label, without workflow authority. */
  label(id: number | 'user', ctx: Context): Promise<string>
  /** The same question summary that the message cards use. */
  summary(message: Pick<Message, 'text' | 'questions'>): string
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: number,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
  /**
   * From the primary agent's conversation `from`, message another project's primary agent (on `machine`, else where it
   * runs): only that Ultimate receives it. With `reply`, its answer returns here as a reply. Returns this log's id of the
   * message and the target's id of the delivered one; throws a sentence naming the machine when it cannot be reached.
   */
  tell(
    from: number,
    input: { project: string; machine?: string; text: string; reply?: boolean },
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<{ message: number; delivered: number }>
}
export { MessageSent } from './refs.ts'
export type { Question, Remote, ImagesRef } from './refs.ts'
/** Messages between conversations; core, so `need` it. */
export const MessagesApi = defineApi<MessagesService>()('messages')

export type MessagesWorkflowService = {
  /** The workflow's primary conversation inside this transaction; absent means no primary privilege. */
  primary(tx: Tx): Promise<ConversationId | undefined>
  /** Refuse a model's user-directed message unless the workflow grants its existing permission. */
  authorizeUserMessage(from: number | 'user', ctx: Context): Promise<void>
  /** The workflow starter, distinct from a child's direct parent. */
  starter(id: number | 'user', ctx: Context): Promise<number | undefined>
  /** A branch reply still needs its starter's answer. */
  replyAwaits(tx: Tx, from: number, to: Message['to']): Promise<boolean>
  /** The existing full-app message instructions, including branch rules. */
  instructions(id: ConversationId, ctx: Context): Promise<string>
  /** Record the existing note when a side chat sends a message for its parent. */
  sideChatMessage(input: {
    from: number
    conversation: ConversationId
    to: Message['to']
    text: string
    requestId: string
  }): Promise<void>
  /** A branch report that this run read still needs an answer. */
  awaitsReport(tx: Tx, id: ConversationId, read: number[]): Promise<boolean>
  /** Apply workflow-only recipient rules, such as refusing input to a read-only tally. */
  validateRecipient(tx: Tx, id: ConversationId): Promise<void>
  /** Extra context about the request a branch serves; empty outside that workflow relationship. */
  servesLine(tx: Tx, from: Message['from'], to: Message['to']): Promise<string>
  /** Whether this conversation sees all user questions and the instruction for settling them. */
  questionContext(tx: Tx, id: ConversationId): Promise<{ all: boolean; settleHint?: string }>
  /** Record the workflow's passive question notices in the message transaction. */
  posted(
    tx: Tx,
    message: Message,
    options: {
      answerId?: number
      callId?: string
      via?: Via
      dismiss?: boolean
      primary?: ConversationId
    },
  ): Promise<void>
  /** Settle a user question through the existing acting-conversation and input checks. */
  settle(
    from: ConversationId | undefined,
    input: { messageId: number; text: string; dismiss?: boolean },
    ctx: Context,
  ): Promise<number>
  /** Send a remote-project message with the workflow's existing primary-agent restriction. */
  tell(
    from: number,
    input: { project: string; machine?: string; text: string; reply?: boolean },
    ctx: Context,
    signal?: AbortSignal,
    route?: { key: string; routed: EntryId },
  ): Promise<{ message: number; delivered: number }>
  /** Admit an authenticated remote action; the web handler still enforces its user-only restriction. */
  remote(
    input: {
      key: string
      text: string
      reply: boolean
      from: { project: string; machine: string }
    },
    ctx: Context,
  ): Promise<number>
  /** Admit a remote reply after the web handler's user-only check and the workflow's receipt check. */
  remoteReply(
    input: { key: string; text: string; failed?: boolean; stopped?: boolean },
    ctx: Context,
  ): Promise<number>
  /** The workflow's cross-project prompt section; ordinary messages need no such section. */
  projects(): Promise<string | undefined>
}
/** Optional coding rules; their absence never authorizes user or remote-project actions. */
export const MessagesWorkflow = defineApi<MessagesWorkflowService>()('messages.workflow')

export const tier = 'core'

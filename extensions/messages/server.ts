import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { Messages, MessagesApi, MessagesWorkflow } from './api.ts'
import { imagesParameter } from '../../lib/entries.ts'
import { gist, openQuestion, openQuestionsNote, questionsParameter } from './questions.ts'
import { callerOf } from './caller.ts'
import { CallerAction, SettleAction } from './refs.ts'
import type { Via } from './refs.ts'
import { implementAction } from '../../lib/actions.ts'
import { isOwed } from '../../lib/message-state.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { SCAN_PAGE } from './images.ts'
import { parentOf, senderName } from './addresses.ts'
import { delivery } from './delivery.ts'
import { append } from './log.ts'
import { send } from './send.ts'
import type { Device } from '../../shared/events.ts'
import type { Context } from '@earendil-works/chord/context'

export { gist, openQuestionsNote } from './questions.ts'
export const docs = [Messages]

async function openMessage(host: ExtensionHost, messageId: number, ctx: Context) {
  const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
  const message = log?.messages.find((m) => m.id === messageId)
  if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
  return message
}
/** The user's answer `text` to open message `messageId`, or @ultimate's on their behalf (`via`). */
async function answer(
  host: ExtensionHost,
  messageId: number,
  text: string,
  ctx: Context,
  options: { device?: Device; via?: { via: Via; primary: number; fromLabel: string } } = {},
) {
  const message = await openMessage(host, messageId, ctx)
  // @ultimate settling its own question has the answer already: a one-way note, not another turn.
  const own = options.via !== undefined && message.from === options.via.primary
  return send(
    host,
    'user',
    { to: `#${message.from}`, text, re: messageId, ...(own ? { reply: false } : {}) },
    ctx,
    {
      answerId: messageId,
      ...(own ? { note: true } : {}),
      device: options.device,
      ...(options.via ? { via: options.via.via, fromLabel: options.via.fromLabel } : {}),
    },
  )
}
/** Close open message `messageId` unanswered: the user's dismissal, or @ultimate's on their behalf with `reason`. */
async function dismiss(
  host: ExtensionHost,
  messageId: number,
  ctx: Context,
  options: { device?: Device; via?: Via; reason?: string; fromLabel?: string } = {},
) {
  const message = await openMessage(host, messageId, ctx)
  const { reason, ...rest } = options
  // A one-way note: the asker reads it with its next input, and no run starts for it.
  return send(
    host,
    'user',
    {
      to: `#${message.from}`,
      text: reason
        ? `Your question (message ${messageId}) is closed without an answer: ${reason}\nAsk again only if it still matters.`
        : `The user dismissed your question (message ${messageId}): ${gist(message)}\nIt is closed without an answer; ask again only if it still matters.`,
      reply: false,
      re: messageId,
      dismiss: true,
    },
    ctx,
    { answerId: messageId, note: true, ...rest },
  )
}
function requireWorkflow(host: ExtensionHost) {
  const workflow = host.want(MessagesWorkflow)
  if (!workflow) throw new Error('The coding workflow is not available')
  return workflow
}
export const actions = {
  [CallerAction.name]: implementAction(CallerAction, async (args, { host }) => {
    const { conversation, call } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(conversation) || (conversation as number) < 1)
      throw new Error('conversation must be a conversation id')
    if (typeof call !== 'string' || !call) throw new Error('call must be a tool call id')
    // A nested codemode call (`<script>/<n>`) was made by the response that called the script.
    const id = call.split('/')[0]
    return host.harness().commit(async (tx) => {
      let cursor: Parameters<Tx['scanEntries']>[2]
      do {
        const page = await tx.scanEntries(
          { conversationId: conversation as ConversationId },
          SCAN_PAGE,
          cursor,
        )
        const found = callerOf(page.items, id)
        if (found) return { entry: found.id }
        cursor = page.next
      } while (cursor !== undefined)
      return {}
    }, BACKGROUND_CONTEXT)
  }),
  settle: implementAction(SettleAction, async (args, { host, conversationId }) => {
    const { messageId, text, dismiss: closing } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(messageId)) throw new Error('messageId must be a message id')
    if (typeof text !== 'string' || !text.trim())
      throw new Error("text must hold the user's answer, or why the question no longer matters")
    if (closing !== undefined && typeof closing !== 'boolean')
      throw new Error('dismiss must be a boolean')
    const ctx = BACKGROUND_CONTEXT
    return {
      id: await requireWorkflow(host).settle(
        conversationId as ConversationId | undefined,
        {
          messageId: messageId as number,
          text: text.trim(),
          dismiss: closing,
        },
        ctx,
      ),
    }
  }),
  async addresses(_args: unknown, { host }: ActionContext) {
    const agents = await host.need(SubagentsApi).residents(BACKGROUND_CONTEXT)
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    const conversations = host
      .conversations()
      .filter((c) => !c.parentConversationId)
      .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
      .slice(0, 50)
    return {
      agents: agents.map((a) => ({
        ...a,
        ...(index?.[a.name] === undefined ? {} : { id: index[a.name] }),
      })),
      conversations,
    }
  },
}
export default function messages(host: ExtensionHost) {
  host.need(SubagentsApi)
  host.implement(MessagesApi, {
    answer: (messageId, text, ctx, device, via) =>
      answer(host, messageId, text, ctx, { device, via }),
    dispatch: (from, input, ctx, options) => send(host, from, input, ctx, options),
    append: (tx, input) => append(tx, input, host.want(MessagesWorkflow)),
    notify: async (conversation, input, ctx) => {
      await conversation.submit(
        {
          type: 'input',
          content: input.text,
          whenBusy: 'followUp',
          requestId: input.requestId,
          entry: input.entry,
        },
        ctx,
      )
    },
    deliver: async (tx, input) => {
      await tx.createTask(delivery(host), input, {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      })
    },
    parent: (id, ctx) => parentOf(host, id, ctx),
    label: (id, ctx) => senderName(host, id, ctx),
    summary: gist,
    openQuestions: async (ctx) =>
      (
        (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
      ).flatMap((m) =>
        openQuestion(m) && typeof m.from === 'number'
          ? [{ message: m.id, conversation: m.from, at: m.at, text: gist(m) }]
          : [],
      ),
    dismiss: (messageId, ctx, device, settlement) =>
      dismiss(host, messageId, ctx, { device, ...settlement }),
    send: (from, input, requestId, ctx) => send(host, from, input, ctx, { requestId }),
  })
  return defineExtension({
    name: 'messages',
    tasks: [delivery(host)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.2 provides the patched transactional beforeInput hook.
        beforeInput: async (_input, api) =>
          openQuestionsNote(
            api.tx,
            api.conversationId,
            Date.now(),
            await host.want(MessagesWorkflow)?.questionContext(api.tx, api.conversationId),
          ),
      }),
    ],
    sections: [
      section('messages', async (input, ctx) => {
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        const parent = await parentOf(host, input.conversationId, ctx)
        if (parent !== undefined)
          return `Use message only to update #${parent}, the conversation that started you, while you work; your final answer reaches it anyway. One-way updates (reply: false) reach #${parent} as notes it reads with its next input; ask with reply: true when you need its answer to continue.`
        const workflow = host.want(MessagesWorkflow)
        if (workflow) return workflow.instructions(input.conversationId, ctx)
        const agents = await host.need(SubagentsApi).residents(ctx)
        return `Use message to contact #id or @name. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply. A message to an agent whose message you still owe an answer becomes that answer and ends your run; use it only to attach images.\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),
    ],
    tools: [
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name; it returns immediately. A busy recipient gets it after its current run, or during it with steer: true. Workflow rules may set a different default. images forwards screenshots or other images from your conversation, to an agent or to the user. To an agent or the user whose message you owe an answer, it is that answer (with its images and questions). One to an agent ends your run; one to the user ends it too, unless a reply or report still needs your answer. Sent from codemode or beside other calls in its tool round, it never ends the run.',
        parameters: obj({
          to: str(),
          text: str({ minLength: 1 }),
          reply: opt(bool()),
          steer: opt(bool()),
          images: opt(imagesParameter),
          questions: opt(questionsParameter),
        }),
        // The task-scoped receipt deduplicates admission; the memo returns the same id on replay.
        replay: 'safe',
        async execute(input, api, ctx) {
          // A temporary copy cannot use main's privilege to message the user.
          const from =
            input.to === 'user' ? api.conversationId : await actingAs(host, api.conversationId, ctx)
          const id =
            (await api.memo<number>('message-id', ctx)) ??
            (await api.memo(
              'message-id',
              await send(host, from, { ...input, imagesFrom: api.conversationId }, ctx, {
                taskId: api.taskId,
                callId: api.callId,
              }),
              ctx,
            ))
          const sent = (await host
            .harness()
            .snapshot(Messages, ROOT_CONVERSATION_ID, ctx))!.messages.find(
            (message) => message.id === id,
          )
          // It answered a message the recipient is waiting on: the answer is given, so the run ends here. A message to
          // the user answers theirs too, but shows as their message below; the check after it ends the run.
          if (sent?.re !== undefined && sent.to !== 'user')
            return {
              output: [
                {
                  type: 'text',
                  text: `Sent as your answer to message ${sent.re}.`,
                },
              ],
              control: { terminate: true as const },
            }
          if (from !== api.conversationId && input.reply !== false && sent) {
            await host.want(MessagesWorkflow)?.sideChatMessage({
              from,
              conversation: api.conversationId,
              to: sent.to,
              text: input.text,
              requestId: `sidechat:message:${api.taskId}:${api.callId}`,
            })
          }
          if (input.to !== 'user')
            return { output: [{ type: 'text', text: `Message ${id} sent.` }] }
          // End after a user-directed answer unless another read reply is due. Queued replies get their own turn.
          // Pi ends a run only when every call terminates; nested codemode calls never end it.
          // The workflow can also keep a run open for a report it read (#570368).
          const inputs =
            (await host.harness().snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs ?? []
          const read = (
            await Promise.all(
              inputs.map(async (s) => (await host.harness().submission(s, ctx))?.status(ctx)),
            )
          ).flatMap((s) => (s?.type === 'input' && s.entry !== undefined ? [s.entry] : []))
          const owed = await host
            .harness()
            .commit(
              async (tx) =>
                (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
                  (m) => m.to === api.conversationId && isOwed(m),
                ) ||
                (await host.want(MessagesWorkflow)?.awaitsReport(tx, api.conversationId, read)) ===
                  true,
              ctx,
            )
          return {
            output: [{ type: 'text', text: `Message ${id} sent.` }],
            ...(owed ? {} : { control: { terminate: true as const } }),
          }
        },
      }),
    ],
  })
}

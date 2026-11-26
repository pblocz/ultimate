import type { Context } from '@earendil-works/chord/context'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import { defineTool, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { actingAs } from '@ultimate/lib/acting-as.ts'
import { imagesParameter } from '@ultimate/lib/entries.ts'
import { isOwed } from '@ultimate/lib/message-state.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { Messages, MessagesWorkflow } from './api.ts'
import { questionsParameter } from './questions.ts'
import { send } from './send.ts'

export function messageTools(host: ExtensionHost) {
  const common = { text: str({ minLength: 1 }), images: opt(imagesParameter) }
  async function deliver(input: Parameters<typeof send>[2], api: ToolExecutionApi, ctx: Context) {
    // Credit a side chat's main conversation only for agent traffic, never for user permission.
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
    const output = [{ type: 'text' as const, text: `Message ${id} sent.` }]
    if (input.to !== 'user') {
      const sent = (
        await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
      )?.messages.find((message) => message.id === id)
      if (sent?.re !== undefined)
        return {
          output: [{ type: 'text' as const, text: `Sent as your answer to message ${sent.re}.` }],
          control: { terminate: true as const },
        }
      if (from !== api.conversationId && input.reply !== false && sent)
        await host.want(MessagesWorkflow)?.sideChatMessage({
          from,
          conversation: api.conversationId,
          to: sent.to,
          text: input.text,
          requestId: `sidechat:message:${api.taskId}:${api.callId}`,
        })
      return { output }
    }
    // End the turn unless it still owes a read reply or report. Nested Codemode calls never end it.
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
          (await host.want(MessagesWorkflow)?.awaitsReport(tx, api.conversationId, read)) === true,
        ctx,
      )
    return { output, ...(owed ? {} : { control: { terminate: true as const } }) }
  }
  return [
    defineTool({
      name: 'agent_message',
      description:
        'Send to another conversation by #id or @name. A busy recipient gets it after its current run, or during it with steer: true. Use reply: false for a one-way message. Use images to forward images from this conversation. If you owe the recipient an answer, a reply-expected message becomes that answer and ends your turn.',
      parameters: obj({
        ...common,
        to: str({ pattern: '^(#[0-9]+|@[^\\s]+)$' }),
        reply: opt(bool()),
        steer: opt(bool()),
      }),
      // The call receipt commits with the board record.
      replay: 'safe',
      execute: deliver,
    }),
    defineTool({
      name: 'ask_user',
      description:
        'Ask the user structured questions. End your turn instead of waiting. The answer wakes this conversation. Use images to attach examples if needed.',
      parameters: obj({ ...common, questions: questionsParameter }),
      // The call receipt commits with the question.
      replay: 'safe',
      execute: (input, api, ctx) => deliver({ ...input, to: 'user', reply: true }, api, ctx),
    }),
    defineTool({
      name: 'report_user',
      description:
        'Write a one-way update to the user in this conversation. This does not ask for an answer. Use a normal final answer for a normal chat reply.',
      parameters: obj(common),
      // The call receipt commits with the report.
      replay: 'safe',
      execute: (input, api, ctx) => deliver({ ...input, to: 'user', reply: false }, api, ctx),
    }),
  ]
}

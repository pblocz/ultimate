import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import type { MessagesWorkflowService } from '../messages/api.ts'
import { notice } from './notice.ts'

/** The picks from a numbered answer, or its first line. */
const answerSummary = (text: string) => {
  const lines = text.split('\n').filter((line) => line.trim())
  const picks = lines.flatMap((line) => /^(\d+[a-z,]*)[.:]/.exec(line)?.[1] ?? [])
  return picks.length ? picks.join(' ') : (lines[0] ?? '')
}

/** Preserve the primary agent's passive notices in the message admission transaction. */
export async function posted(
  host: ExtensionHost,
  ...[tx, message, options]: Parameters<MessagesWorkflowService['posted']>
) {
  const { from, to, questions, text } = message
  const { primary: primaryId, answerId, callId, via, dismiss } = options
  if (primaryId === undefined) return
  const asked = to === 'user' && message.reply && from !== primaryId && typeof from === 'number'
  const answered =
    from === 'user' && answerId !== undefined && typeof to === 'number' && to !== primaryId
  const notification = asked
    ? {
        kind: 'board.asked' as const,
        // The pointer remains useful after the bounded message log drops the message.
        data: {
          message: message.id,
          from,
          ...(callId === undefined ? {} : { call: callId }),
          summary: questions?.length
            ? `asks you ${questions.length} question${questions.length === 1 ? '' : 's'} · ${questions[0].text}`
            : `asks you · ${text.split('\n')[0]}`,
        },
        content: `#${from} asked the user (message ${message.id}): ${host.need(MessagesApi).summary(message)}. The user answers there; their answer reaches you as a note.`,
      }
    : answered
      ? {
          kind: 'board.answered' as const,
          data: {
            message: answerId,
            from: to,
            ...(via ? { via } : {}),
            ...(dismiss ? { dismissed: true } : { summary: answerSummary(text) }),
          },
          content: via
            ? `You settled #${to}'s questions (message ${answerId}) for the user${dismiss ? ', closed without an answer' : ''}.`
            : dismiss
              ? `The user dismissed #${to}'s questions (message ${answerId}).`
              : `The user answered #${to}'s questions (message ${answerId}):\n${text}`,
        }
      : undefined
  if (notification)
    await tx.createTask(
      notice(host),
      { to: primaryId, ...notification },
      {
        conversationId: primaryId,
        ownership: { kind: 'conversation' },
        background: true,
      },
    )
}

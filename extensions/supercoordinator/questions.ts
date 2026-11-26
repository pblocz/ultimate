import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { Messages, MessagesApi } from '@ultimate/ext/messages/api.ts'
import { SubagentsApi } from '@ultimate/ext/subagents/api.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { BranchQuestionAsked, BranchQuestionResolved } from '@ultimate/shared/branch-questions.ts'
import { notice } from './notice.ts'
import type { BranchNotice } from './notice.ts'

/** The picks from a numbered answer, or its first line. */
function answerSummary(text: string) {
  const lines = text.split('\n').filter((line) => line.trim())
  const picks = lines.flatMap((line) => /^(\d+[a-z,]*)[.:]/.exec(line)?.[1] ?? [])
  return picks.length ? picks.join(' ') : (lines[0] ?? '')
}

export function subscribeToBranchQuestions(host: ExtensionHost) {
  const queue = (tx: Tx, input: BranchNotice) =>
    tx.createTask(notice(host), input, {
      conversationId: input.to as ConversationId,
      ownership: { kind: 'conversation' },
      background: true,
    })
  host.need(SubagentsApi)
  host.need(MessagesApi)
  host.react(
    'branch-questions',
    [BranchQuestionAsked, BranchQuestionResolved],
    async (tx, event) => {
      const to = (await host.need(SubagentsApi).coordinator(BACKGROUND_CONTEXT, tx))?.id
      if (to === undefined) return
      const messages = host.need(MessagesApi)
      const log = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
      const { branch: from, question: message } = event.data
      if (!BranchQuestionResolved.is(event)) {
        const question = log.find((item) => item.id === message)
        const about = `#${from} asked the user (message ${message})`
        await queue(tx, {
          to,
          kind: 'board.asked',
          data: {
            message,
            from,
            ...(question?.call === undefined ? {} : { call: question.call }),
            summary: question?.questions?.length
              ? `asks you ${question.questions.length} question${question.questions.length === 1 ? '' : 's'} · ${question.questions[0].text}`
              : question
                ? `asks you · ${question.text.split('\n')[0]}`
                : `asked you · message ${message}`,
          },
          content: `${question ? `${about}: ${messages.summary(question)}` : about}. The user answers there; their answer reaches you as a note.`,
        })
      } else {
        const { response: responseId, outcome } = event.data
        const response = log.find((item) => item.id === responseId)
        const via = response?.via
        const dismissed = outcome === 'dismissed'
        const about = `#${from}'s questions (message ${message})`
        await queue(tx, {
          to,
          kind: 'board.answered',
          data: {
            message,
            from,
            ...(via ? { via } : {}),
            ...(dismissed
              ? { dismissed: true }
              : response
                ? { summary: answerSummary(response.text) }
                : {}),
          },
          content: via
            ? `You settled ${about} for the user${dismissed ? ', closed without an answer' : ''}.`
            : dismissed
              ? `The user dismissed ${about}.`
              : response
                ? `The user answered ${about}:\n${response.text}`
                : `The user answered ${about}.`,
        })
      }
    },
    { from: 'now' },
  )
}

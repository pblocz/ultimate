import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { Started } from '@ultimate/ext/messages/api.ts'
import type { MessagesWorkflowService } from '@ultimate/ext/messages/api.ts'
import { BranchQuestionAsked, BranchQuestionResolved } from '@ultimate/shared/branch-questions.ts'

/** Publish the facts with the message, even when no coordinator is present. */
export async function posted(
  host: ExtensionHost,
  ...[tx, message, { answerId, dismiss }]: Parameters<MessagesWorkflowService['posted']>
) {
  const { from, to, id, reply } = message
  if (to === 'user' && reply && typeof from === 'number') {
    if ((await tx.doc(Started, from as ConversationId)).by !== undefined)
      await host.emit(tx, BranchQuestionAsked, { branch: from, question: id })
  } else if (from === 'user' && answerId !== undefined && typeof to === 'number') {
    if ((await tx.doc(Started, to as ConversationId)).by !== undefined)
      await host.emit(tx, BranchQuestionResolved, {
        branch: to,
        question: answerId,
        response: id,
        outcome: dismiss ? 'dismissed' : 'answered',
      })
  }
}

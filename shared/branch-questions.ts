import { defineEvent } from './events.ts'

/** A coding branch asked the user a question that expects a reply. */
export const BranchQuestionAsked = defineEvent<{ branch: number; question: number }>(
  'coding-workflow.branch-question-asked',
)

/** The user answered or dismissed a coding branch's question. Text stays in the bounded message log. */
export const BranchQuestionResolved = defineEvent<{
  branch: number
  question: number
  response: number
  outcome: 'answered' | 'dismissed'
}>('coding-workflow.branch-question-resolved')

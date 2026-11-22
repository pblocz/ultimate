/** Watchdog failure cards: the failed conversation, error, last step and retry outcome. */
export type Failure = {
  conversation: number
  title: string
  error: string
  step: string
  hint?: string
  retried: boolean
  /** How many automatic continuations ran before this report, when more than one. */
  retries?: number
}

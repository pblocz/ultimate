/** Coding tools: Pi's file and shell tools, their transcript renderers, and optional shell instrumentation. */
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import type { BashExecution } from '@earendil-works/pi-durable/tools'
import { defineApi } from '@ultimate/shared/extension-api.ts'

export { Committed } from './refs.ts'

/** An optional provider can check and observe a Bash call. */
export type BashInstrumentationService = {
  /** Name a change that makes the command unsuitable for an interruptible wait, if any. */
  unsafeCommand(command: string): string | undefined
  /** Prepare and finish the same call even if the provider reloads. */
  start(api: ToolExecutionApi): {
    prepare(execution: BashExecution): void
    finish(context: Context): Promise<void>
  }
}

/** The optional point for Bash execution policy and call-local observation. */
export const BashInstrumentation = defineApi<BashInstrumentationService>()('coding-tools.bash')

export const tier = 'core'

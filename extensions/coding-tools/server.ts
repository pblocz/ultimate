import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { bool, num, obj, opt, str } from '@earendil-works/pi-schema'
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolPark,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { implementAction } from '@ultimate/lib/actions.ts'
import { watchSteer } from '@ultimate/lib/steer.ts'
import { BashInstrumentation } from './api.ts'
import { CancelAction, CancelledDoc } from './refs.ts'

/** Agent shells must not inherit the in-process Vite server's `NODE_ENV=development`. */
const dropHostNodeEnv = 'unset NODE_ENV'

/** Lets Pi's read tool shrink an image past the model's limits (2000x2000 by default) instead of refusing it. */
const images = await createNodePhotonImages()

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

/** Why a command marked `interruptible` must not be cut mid-way, if it changes something; `undefined` when it only waits. */
export function changes(command: string) {
  // Bash joins backslash-newline continuations before it runs a line.
  const joined = command.replaceAll('\\\n', ' ')
  // A word of its own (npm install, composer install, artisan migrate:fresh), not part of a path or file name.
  return /(?:^|[\s;&|(])(install|migrate)(?=$|[\s;&|):])/.exec(joined)?.[1]
}

/**
 * The bash calls the user cancelled (`CancelAction`), by call id → when. Durable, so a call started before an extension
 * reload sees a cancel made after it. A restart ends a running call anyway: Pi recovers it as interrupted.
 */
const Cancelled = defineDoc<{ calls: Record<string, number> }>({
  kind: CancelledDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: {} }),
})
export const docs = [Cancelled]

/** `40s`, `5m 09s`, `2h 05m`. */
function took(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/**
 * Run `run` until it finishes or is stopped, whichever comes first: by the user's cancel of this call, or, when
 * `interruptible`, by a steer queued in its conversation. A steer joins a run only after the tool round, so a wait would
 * otherwise hold it; ending the command here lets the run go on and the steer be placed at once. Follow-ups wait for the
 * run's end anyway, so they never interrupt. A stopped command is killed, and the call ends with the output so far and a
 * notice, as an ordinary result.
 */
async function untilStopped(
  run: (context: Context) => Promise<ToolExecutionResult | ToolPark>,
  api: ToolExecutionApi,
  interruptible: boolean | undefined,
  context: Context,
): Promise<ToolExecutionResult | ToolPark> {
  const id = api.conversationId
  // A watch needs the document to exist; created once per conversation.
  if (!(await api.snapshot(Cancelled, id, context)))
    await api.commit((tx) => tx.doc(Cancelled, id), context)
  const cancelled = (await api.watchDoc(Cancelled, id, context))!
  const started = performance.now()
  const { context: command, cancel } = withCancel(context)
  let reason: string | undefined
  const stop = (why: string) => {
    if (reason) return
    reason = why
    cancel(new Error(why))
  }
  const inspectCancelled = (value: typeof cancelled.value) => {
    if (value?.calls[api.callId] !== undefined) stop('Cancelled by the user')
  }
  cancelled.start(async (call) => {
    if (call.kind === 'value') inspectCancelled(call.value)
  })
  const stopSteer = interruptible
    ? await watchSteer(api, context, () => stop('Interrupted by a steering message'))
    : undefined
  try {
    inspectCancelled(cancelled.value)
    return await run(command)
  } catch (error) {
    if (!reason || context.abortSignal?.aborted) throw error
    const retained = api.retainedOutput()
    // The notice goes last: long output keeps its tail, so a leading notice would be cut.
    return {
      output: [
        {
          type: 'text',
          text: `${retained.text || '(no output)'}\n[${reason} after ${took(performance.now() - started)}; the output above is the last the command printed.]`,
        },
      ],
      structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 130 },
    }
  } finally {
    await Promise.all([cancelled.stop(), stopSteer?.()])
  }
}

export const userActions = ['cancel']
export const actions = {
  cancel: implementAction(CancelAction, async (args, { host, conversationId }) => {
    const callId =
      args && typeof args === 'object' && !Array.isArray(args) ? args.callId : undefined
    if (typeof callId !== 'string' || conversationId === undefined)
      throw new Error('Invalid bash call')
    const id = conversationId as ConversationId
    await host.harness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, id)
      const running = new Set(
        [...(live.tools ?? []), ...(live.nestedTools ?? [])].flatMap((slot) =>
          slot.name === 'bash' && slot.status === 'running' ? [slot.callId] : [],
        ),
      )
      if (!running.has(callId)) throw new Error('That bash call is not running')
      const calls = (await tx.doc(Cancelled, id)).calls
      // Calls never remove their own marks (one could land as a call ends); each cancel drops those of ended calls.
      for (const ended of Object.keys(calls)) if (!running.has(ended)) delete calls[ended]
      calls[callId] = Date.now()
    }, BACKGROUND_CONTEXT)
    return null
  }),
}

export default function codingTools(host: Pick<ExtensionHost, 'want'>) {
  const shell = createBashTool()
  const parameters = obj({
    command: str({ description: 'Bash command to execute' }),
    timeout: opt(
      num({
        description:
          'Timeout in seconds (optional; without it a default tripwire, 600 s unless configured, stops the command)',
      }),
    ),
    interruptible: opt(
      bool({
        description:
          'Only for commands that just wait or poll (CI checks, deploys, a file appearing): a steering message ends the command early. Never combine with commands that change things.',
      }),
    ),
  })
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool = defineTool({
    ...shell,
    parameters,
    async execute({ interruptible, ...args }, api, context) {
      const provider = host.want(BashInstrumentation)
      const change = interruptible
        ? (provider?.unsafeCommand(args.command) ?? changes(args.command))
        : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      const instrument = provider?.start(api)
      const call = createBashTool({
        commandPrefix: dropHostNodeEnv,
        ...(instrument ? { prepare: (execution) => instrument.prepare(execution) } : {}),
      })
      const run = (command: Context) => call.execute(args, api, command)
      try {
        return await untilStopped(run, api, interruptible, context)
      } finally {
        await instrument?.finish(context).catch((error: unknown) =>
          // Instrumentation must not replace the result of the command.
          console.error('bash instrumentation failed:', error),
        )
      }
    },
  })
  return defineExtension({
    name: 'coding-tools',
    // Each tool keeps its own parameters; the list is only read through the base registration.
    tools: [
      createReadTool({ images }),
      createWriteTool(),
      createEditTool(),
      bashTool,
    ] as ToolRegistration[],
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          if (args.timeout !== undefined) return bash.execute(args, api, context)
          const timeout = defaultBashTimeout()
          try {
            return await bash.execute({ ...args, timeout }, api, context)
          } catch (error) {
            if (
              error instanceof Error &&
              /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
            )
              throw new Error(bashTripwireMessage(timeout), { cause: error })
            throw error
          }
        },
      })),
    ],
  })
}

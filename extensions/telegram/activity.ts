import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AssistantEntry, LiveDoc, ToolTask } from '@earendil-works/pi-durable'
import type {
  CommitPublication,
  ConversationId,
  EntryRecord,
  Harness,
  LiveState,
  SubmissionId,
} from '@earendil-works/pi-durable'
import type { Address } from './channel.ts'
import type { ledger } from './state.ts'
import { toolPreview } from './tool-preview.ts'
import { toolProgress } from './tool-progress.ts'
import type { ProgressTransport } from './tool-progress.ts'

type Transport = {
  typing(chat: string, signal: AbortSignal): Promise<unknown>
  reaction(address: Address, add: boolean, signal: AbortSignal): Promise<void>
  progress: ProgressTransport
  assistantUpdate(
    address: Address,
    conversation: number,
    entry: number,
    text: string,
  ): Promise<void>
}
type Input = Address & {
  key: string
  conversation: number
  id?: number
  status?: 'queued' | 'placed' | 'done' | 'unanswered'
  reacted: boolean
  changing?: boolean
  attempted?: boolean
  wasActive?: boolean
}

type Heartbeat = {
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  sending: boolean
  blockedUntil: number
  refresh: boolean
}
const interval = 3_000

export function turnActivity(
  harness: Harness,
  state: ReturnType<typeof ledger>,
  bot: string,
  transport: Transport,
  root: string,
) {
  const controller = new AbortController()
  const inputs = new Map<string, Input>()
  const runs = new Map<number, LiveState>()
  const beats = new Map<string, Heartbeat>()
  const progress = new Map<
    number,
    {
      run: number
      round?: number
      labels: Map<string, string>
      message: ReturnType<typeof toolProgress>
    }
  >()
  const recovered = new Map<number, number>()
  const editAt = new Map<string, number>()
  let scheduled = false
  const requestId = (key: string) => `telegram:${bot}:${key}`

  function scheduleBeat(chat: string, beat: Heartbeat, delay: number, retry = false) {
    clearTimeout(beat.timer)
    const wait = Math.max(delay, beat.blockedUntil - Date.now())
    const send = () => {
      void pulse(chat, beat, retry).catch(() => stopBeat(chat, beat))
    }
    if (wait <= 0) send()
    else beat.timer = setTimeout(send, wait)
  }
  async function pulse(chat: string, beat: Heartbeat, retry: boolean) {
    if (beat.controller.signal.aborted || beat.sending) return
    beat.sending = true
    beat.refresh = false
    const start = Date.now()
    let delay = interval
    let again = false
    try {
      await transport.typing(chat, beat.controller.signal)
    } catch (error) {
      // The signal expires if the transport is unavailable. Never block the turn on it.
      const limit =
        error instanceof Error && ('retryAfter' in error || error.name === 'AdapterRateLimitError')
      if (limit) {
        const seconds =
          'retryAfter' in error && typeof error.retryAfter === 'number' ? error.retryAfter : 3
        beat.blockedUntil = Date.now() + seconds * 1_000
      } else if (!retry) {
        delay = 0
        again = true
      }
    } finally {
      beat.sending = false
      if (!beat.controller.signal.aborted)
        scheduleBeat(chat, beat, beat.refresh ? 0 : delay - (Date.now() - start), again)
    }
  }
  function stopBeat(chat: string, beat: Heartbeat) {
    beats.delete(chat)
    clearTimeout(beat.timer)
    beat.controller.abort()
  }

  async function react(input: Input, add: boolean) {
    input.changing = true
    try {
      if (add) {
        // Record the intent first. A lost response can still mean Telegram added the reaction.
        await state.change((data) => {
          data.inputs[input.key].queueReaction = true
        })
        input.reacted = true
      }
      if (controller.signal.aborted) return
      if (!add || input.status === 'queued') await transport.reaction(input, add, controller.signal)
      if (!add) {
        await state.change((data) => {
          delete data.inputs[input.key].queueReaction
        })
        input.reacted = false
      }
    } catch {
      // A failed reaction must not affect input or reply delivery. Recovery can remove a stale reaction.
      input.attempted = !add || input.status === 'queued'
    } finally {
      input.changing = false
      schedule()
    }
  }
  function reconcile() {
    scheduled = false
    if (controller.signal.aborted) return
    const chats = new Set<string>()
    const conversations = new Set<number>()
    for (const [request, input] of inputs) {
      if (
        input.id !== undefined &&
        runs.get(input.conversation)?.run?.inputs.some((id) => id === input.id)
      )
        input.wasActive = true
      if (input.wasActive && (input.status === 'placed' || input.status === 'done'))
        chats.add(input.chat)
      if (!input.changing && !input.attempted && input.status) {
        const queued = input.status === 'queued'
        if (queued !== input.reacted)
          void react(input, queued).catch(() => {
            input.attempted = true
          })
      }
      if (!input.changing && input.status === 'unanswered' && (!input.reacted || input.attempted))
        inputs.delete(request)
      else conversations.add(input.conversation)
    }
    for (const [id] of runs) if (!conversations.has(id)) runs.delete(id)
    for (const [chat, beat] of beats) if (!chats.has(chat)) stopBeat(chat, beat)
    for (const chat of chats) {
      if (beats.has(chat)) continue
      const beat = {
        controller: new AbortController(),
        sending: false,
        blockedUntil: 0,
        refresh: false,
      }
      beats.set(chat, beat)
      scheduleBeat(chat, beat, 0)
    }
  }
  function schedule() {
    if (scheduled || controller.signal.aborted) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  function observe(publication: CommitPublication) {
    const changed = new Map<number, LiveState | undefined>()
    for (const change of publication.changes) {
      if (
        change.type === 'document' &&
        change.kind === 'change' &&
        change.record.kind === LiveDoc.definition.kind &&
        change.conversationId !== undefined &&
        runs.has(change.conversationId)
      ) {
        changed.set(change.conversationId, runs.get(change.conversationId))
        runs.set(change.conversationId, change.value)
      } else if (
        change.type === 'submission' &&
        change.value.type === 'input' &&
        change.value.requestId
      ) {
        const input = inputs.get(change.value.requestId)
        if (!input || input.conversation !== change.value.conversationId) continue
        input.id = change.value.id
        if (input.status === 'queued' && change.value.status !== 'queued') input.attempted = false
        input.status = change.value.status
      }
    }
    for (const [id, previous] of changed) {
      observeTools(id, publication)
      const run = runs.get(id)?.run
      const prior = previous?.run
      if (!run || !prior || run.first !== prior.first || run.taskId === prior.taskId) continue
      const closed = publication.changes.find(
        (item) => item.type === 'task' && item.value.id === prior.taskId,
      )
      if (
        closed?.type !== 'task' ||
        closed.value.state.status !== 'terminal' ||
        closed.value.state.outcome.status !== 'completed'
      )
        continue
      const result = closed.value.state.outcome.result
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        typeof result.entryId !== 'number'
      )
        continue
      const entry = publication.changes.find(
        (item) => item.type === 'entry' && item.value.id === result.entryId,
      )
      const input = source(id, prior.inputs)
      if (entry?.type === 'entry' && input) {
        // postText already absorbs delivery failures; this handler only satisfies the floating-promise rule.
        postText(input, entry.value).catch(() => undefined)
      }
    }
    schedule()
  }

  function source(conversation: number, ids: readonly number[]) {
    return [...inputs.values()].find(
      (item) =>
        item.conversation === conversation && item.id !== undefined && ids.includes(item.id),
    )
  }

  function postText(input: Input, entry: EntryRecord) {
    if (!AssistantEntry.is(entry)) return Promise.resolve()
    const reply = entry.model?.find((item) => item.role === 'assistant')
    if (
      reply?.role !== 'assistant' ||
      reply.stopReason === 'error' ||
      reply.stopReason === 'aborted'
    )
      return Promise.resolve()
    const text = reply.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim()
    if (!text) return Promise.resolve()
    const update = transport.assistantUpdate(input, input.conversation, entry.id, text)
    // A failed intermediate delivery must not detach the observer or block final delivery.
    return update.catch(() => undefined)
  }

  function observeTools(id: number, publication: CommitPublication) {
    const live = runs.get(id)
    const run = live?.run
    const current = progress.get(id)
    if (current && (run?.first !== current.run || !run.inputs.length)) {
      progress.delete(id)
      queueMicrotask(() => current.message.end())
    }
    if (run?.first === undefined || !live?.tools?.length) return
    const input = source(id, run.inputs)
    if (!input) return
    input.wasActive = true
    let assistant: EntryRecord | undefined
    for (const change of publication.changes) {
      if (
        change.type !== 'task' ||
        change.value.kind !== ToolTask.definition.name ||
        change.value.owner !== run.taskId
      )
        continue
      const args = change.value.input
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        typeof args.assistant !== 'number'
      )
        continue
      const entryId = args.assistant
      const entry = publication.changes.find(
        (item) => item.type === 'entry' && item.value.id === entryId,
      )
      if (entry?.type === 'entry') {
        assistant = entry.value
        break
      }
    }
    const update = assistant && postText(input, assistant)
    if (recovered.get(id) === run.first) return
    let view = progress.get(id)
    if (assistant !== undefined && !view) {
      const message = toolProgress(
        input,
        {
          async post(...args) {
            await update
            return transport.progress.post(...args)
          },
          async edit(...args) {
            editAt.set(input.chat, Date.now())
            await transport.progress.edit(...args)
          },
        },
        controller.signal,
        () => refresh(input.chat),
        () => Math.max(0, (editAt.get(input.chat) ?? 0) + 2_000 - Date.now()),
      )
      view = { run: run.first, labels: new Map(), message }
      progress.set(id, view)
    }
    if (!view) return
    view.round = assistant?.id ?? view.round
    const reply = assistant?.model?.find((item) => item.role === 'assistant')
    if (reply?.role === 'assistant')
      for (const part of reply.content)
        if (part.type === 'toolCall')
          view.labels.set(`${view.round}:${part.id}`, toolPreview(part.name, part.arguments, root))
    if (view.round === undefined) return
    // Slot results and their entries publish in the same commit. Retain earlier row outcomes when another slot changes.
    for (const slot of live.tools) {
      const result = publication.changes.find(
        (change) => change.type === 'entry' && change.value.id === slot.entry,
      )
      const outcome =
        result?.type === 'entry'
          ? result.value.model?.find((item) => item.role === 'toolResult')
          : undefined
      view.message.update(
        `${view.round}:${slot.callId}`,
        {
          label:
            view.labels.get(`${view.round}:${slot.callId}`) ?? toolPreview(slot.name, {}, root),
          status:
            slot.status === 'pending'
              ? 'waiting'
              : slot.status === 'running'
                ? 'running'
                : outcome?.role === 'toolResult'
                  ? outcome.isError
                    ? 'failed'
                    : 'done'
                  : slot.entry === undefined
                    ? 'failed'
                    : 'done',
        },
        slot.status === 'done' && outcome === undefined && slot.entry !== undefined,
      )
    }
    queueMicrotask(view.message.flush)
  }

  const observation = harness.observeCommits({ advance: observe, end: shutdown })
  function shutdown() {
    controller.abort()
    for (const [chat, beat] of beats) stopBeat(chat, beat)
  }
  function refresh(chat: string) {
    const beat = beats.get(chat)
    if (!beat) return
    if (beat.sending) beat.refresh = true
    else scheduleBeat(chat, beat, 0)
  }
  return {
    track(input: Input) {
      const request = requestId(input.key)
      if (!inputs.has(request)) inputs.set(request, input)
      if (!runs.has(input.conversation)) runs.set(input.conversation, {})
      return request
    },
    async hydrate(request: string, id: number, recover = false) {
      const input = inputs.get(request)
      if (!input) return
      input.id = id
      const prior = runs.get(input.conversation)
      const conversation = input.conversation as ConversationId
      const [live, submission] = await Promise.all([
        harness.snapshot(LiveDoc, conversation, context),
        harness.submission(id as SubmissionId, context),
      ])
      if (runs.get(input.conversation) === prior && live) runs.set(conversation, live)
      if (recover && live?.run?.first !== undefined && !progress.has(conversation))
        recovered.set(conversation, live.run.first)
      input.status ??= (await submission?.status(context))?.status
      schedule()
    },
    forgetUnadmitted(request: string) {
      if (inputs.get(request)?.id === undefined) inputs.delete(request)
      schedule()
    },
    complete(key: string) {
      const input = inputs.get(requestId(key))
      if (input) {
        input.status = 'unanswered'
        input.wasActive = false
      }
      schedule()
    },
    refresh,
    stop() {
      observation.detach()
      shutdown()
    },
  }
}

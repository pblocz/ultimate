import type { TelegramMessage } from '@chat-adapter/telegram'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { ChannelError } from '@ultimate/shared/channel-host.ts'
import type { HistoryItem } from '@ultimate/shared/channel-host.ts'
import { turnActivity } from './activity.ts'
import { botState, ledger } from './state.ts'

export function address(raw: TelegramMessage, allowed: Set<string>) {
  if (
    raw.chat.type !== 'private' ||
    !raw.from ||
    raw.from.is_bot ||
    !allowed.has(String(raw.from.id))
  )
    return undefined
  return { chat: String(raw.chat.id), message: String(raw.message_id), sender: String(raw.from.id) }
}
export type Address = NonNullable<ReturnType<typeof address>>

export function telegramChannel(
  host: ExtensionHost,
  bot: string,
  allowed: ReadonlySet<string>,
  send: (
    chat: string,
    text: { markdown: string },
    replyTo: string,
    signal: AbortSignal,
    timeout: number,
  ) => Promise<string>,
  statusTransport: Omit<Parameters<typeof turnActivity>[3], 'assistantUpdate'>,
) {
  const runtime = host.channelHost().conversations
  const harness = host.harness()
  const state = ledger(harness, bot)
  const stopping = new AbortController()
  const sends = new Map<string, Promise<void>>()
  const activity = turnActivity(harness, state, bot, {
    ...statusTransport,
    assistantUpdate: (from, id, entry, text) =>
      ordered(from.chat, id, async () => {
        const delivered = await sendEntry(from, id, String(entry), text)
        if (delivered) activity.refresh(from.chat)
      }),
  })
  const watchers = new Map<number, { controller: AbortController; scan: () => Promise<void> }>()
  const keyOf = ({ chat, message }: Address) => `${chat}:${message}`
  const notice = (message: string) => host.notice(`Telegram: ${message}`)

  async function answer(id: number, ref: string) {
    let cursor: string | undefined
    for (;;) {
      const page = await runtime.history(id, { direction: 'older', cursor })
      const item = page.items.find((candidate) => candidate.entryRef === ref)
      if (item) return item
      if (!page.continuation) return undefined
      cursor = page.continuation
    }
  }
  function textOf(item: HistoryItem | undefined) {
    return item?.type === 'assistant'
      ? item.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .trim()
      : ''
  }
  function ordered(chat: string, id: number, work: () => Promise<void>) {
    const key = `${chat}:${id}`
    const previous = sends.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    sends.set(key, next)
    return next.finally(() => {
      if (sends.get(key) === next) sends.delete(key)
    })
  }

  async function sendEntry(
    from: Address,
    id: number,
    ref: string,
    text: string,
    finalKey?: string,
  ) {
    if (stopping.signal.aborted) return false
    const delivery = `${from.chat}:${id}:${ref}`
    const claimed = await state.change((data) => {
      if (stopping.signal.aborted) return false
      if (finalKey !== undefined) data.inputs[finalKey].settled = true
      if (data.deliveries[delivery] || !text) return false
      // Once a send starts, no restart can prove whether Telegram received it.
      data.deliveries[delivery] = { status: 'sending' }
      return true
    })
    if (!claimed || stopping.signal.aborted) return false
    try {
      const message = await send(
        from.chat,
        { markdown: text },
        from.message,
        stopping.signal,
        finalKey === undefined ? 8_000 : 90_000,
      )
      if (!stopping.signal.aborted)
        await state.change((data) => {
          data.deliveries[delivery] = { status: 'sent', message }
        })
      return true
    } catch {
      if (!stopping.signal.aborted) {
        await state.change((data) => {
          data.deliveries[delivery] = { status: 'uncertain' }
        })
        notice('Reply delivery is uncertain. It will not be sent again automatically.')
      }
      return false
    }
  }

  async function deliver(id: number) {
    const entries = Object.entries((await state.read()).inputs)
    for (const [key, input] of entries) {
      if (stopping.signal.aborted) return
      if (
        input.conversation !== id ||
        input.submission === undefined ||
        input.settled ||
        !allowed.has(input.sender)
      )
        continue
      const status = await runtime.submission(id, input.submission)
      if (status.status === 'queued' || status.status === 'active') continue
      if (status.status === 'unanswered') {
        await state.change((data) => {
          data.inputs[key].settled = true
        })
        activity.complete(key)
        continue
      }
      if (status.status !== 'answered') continue
      await ordered(input.chat, id, async () => {
        const text = textOf(await answer(id, status.answerRef))
        await sendEntry(input, id, status.answerRef, text, key)
        activity.complete(key)
      })
    }
  }
  const scanFailed = () => {
    if (!stopping.signal.aborted)
      notice('Could not read a reply. Pending replies stay available for recovery.')
  }
  function watch(id: number) {
    if (stopping.signal.aborted) return
    const existing = watchers.get(id)
    if (existing) {
      // A reply can commit before the channel saves the receipt. Scan again after that write.
      void existing.scan().catch(scanFailed)
      return
    }
    const controller = new AbortController()
    let pending = Promise.resolve()
    const scan = () => {
      pending = pending.catch(scanFailed).then(() => deliver(id))
      return pending
    }
    watchers.set(id, { controller, scan })
    void (async () => {
      for await (const snap of runtime.watch(id, { signal: controller.signal })) {
        if (stopping.signal.aborted) break
        if (snap.latestHistoryCursor) await scan().catch(scanFailed)
      }
    })()
      .catch(scanFailed)
      .finally(() => watchers.delete(id))
  }

  const submit = async (from: Address, text: string, whenBusy: 'steer' | 'followUp' = 'steer') => {
    if (stopping.signal.aborted) throw new ChannelError('unavailable', 'Telegram is stopping')
    if (!text.trim()) return
    const key = keyOf(from)
    const before = await state.read()
    if (before.inputs[key]?.submission !== undefined) return
    let id = before.inputs[key]?.conversation ?? before.chats[from.chat]
    if (id === undefined) {
      // Create the conversation and its first binding together. An SDK retry cannot leave an unbound chat.
      const created = await runtime.create({}, async (tx, conversation) => {
        const data = await botState(tx, bot)
        data.chats[from.chat] = conversation
        data.inputs[key] = { ...from, conversation }
      })
      id = created.id
    } else {
      const bound = id
      await state.change((data) => {
        data.inputs[key] ??= { ...from, conversation: bound }
      })
    }
    const request = activity.track({
      ...from,
      key,
      conversation: id,
      reacted: !!before.inputs[key]?.queueReaction,
    })
    const accepted = await runtime
      .submit(id, {
        text,
        whenBusy,
        requestId: request,
        source: {
          channel: 'telegram',
          instanceId: bot,
          chatId: from.chat,
          senderId: from.sender,
          messageId: from.message,
        },
      })
      .catch((error: unknown) => {
        activity.forgetUnadmitted(request)
        throw error
      })
    await state.change((data) => {
      data.inputs[key].submission = accepted.submissionId
    })
    await activity.hydrate(request, accepted.submissionId)
    watch(id)
  }
  async function clear(from: Address) {
    const key = keyOf(from)
    const before = await state.read()
    if (Object.hasOwn(before.clears, key)) return false
    const previous = before.chats[from.chat]
    const config = previous === undefined ? {} : (await runtime.get(previous)).configuration
    const { definition, preset, model, thinkingLevel } = config
    const selection = { definition, ...(preset ? { preset } : { model }), thinkingLevel }
    await runtime.create(selection, async (tx, id) => {
      const data = await botState(tx, bot)
      data.chats[from.chat] = id
      data.clears[key] = id
    })
    return true
  }

  return {
    submit,
    clear,
    refresh: activity.refresh,
    current: async (from: Address) => (await state.read()).chats[from.chat],
    async recover() {
      const uncertain = await state.change((data) => {
        let count = 0
        for (const delivery of Object.values(data.deliveries)) {
          if (delivery.status !== 'sending') continue
          delivery.status = 'uncertain'
          count++
        }
        return count
      })
      if (uncertain)
        notice(
          `${uncertain} pending sends have no confirmation. They will not be sent again automatically.`,
        )
      const ids = new Set<number>()
      for (const [key, input] of Object.entries((await state.read()).inputs)) {
        if (
          input.submission === undefined ||
          !allowed.has(input.sender) ||
          (input.settled && !input.queueReaction)
        )
          continue
        const request = activity.track({ ...input, key, reacted: !!input.queueReaction })
        await activity.hydrate(request, input.submission, true)
        if (input.settled) activity.complete(key)
        else ids.add(input.conversation)
      }
      for (const id of ids) watch(id)
    },
    stop() {
      stopping.abort()
      activity.stop()
      for (const { controller } of watchers.values()) controller.abort()
    },
  }
}

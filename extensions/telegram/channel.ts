import type { TelegramMessage } from '@chat-adapter/telegram'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ChannelError } from '../../shared/channel-host.ts'
import type { HistoryItem } from '../../shared/channel-host.ts'
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
  send: (chat: string, text: string, replyTo?: string) => Promise<string>,
) {
  const runtime = host.channelHost().conversations
  const harness = host.harness()
  const state = ledger(harness, bot)
  const stopping = new AbortController()
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
        continue
      }
      if (status.status !== 'answered') continue
      const text = textOf(await answer(id, status.answerRef))
      const delivery = `${input.chat}:${id}:${status.answerRef}`
      const claimed = await state.change((data) => {
        if (stopping.signal.aborted) return false
        data.inputs[key].settled = true
        if (data.deliveries[delivery] || !text) return false
        // Once a send starts, no restart can prove whether Telegram received it.
        data.deliveries[delivery] = { status: 'sending' }
        return true
      })
      if (!claimed || stopping.signal.aborted) continue
      try {
        const message = await send(input.chat, text, input.message)
        if (!stopping.signal.aborted)
          await state.change((data) => {
            data.deliveries[delivery] = { status: 'sent', message }
          })
      } catch {
        if (stopping.signal.aborted) return
        await state.change((data) => {
          data.deliveries[delivery] = { status: 'uncertain' }
        })
        notice('Reply delivery is uncertain. It will not be sent again automatically.')
      }
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
    const accepted = await runtime.submit(id, {
      text,
      whenBusy,
      requestId: `telegram:${bot}:${key}`,
      source: {
        channel: 'telegram',
        instanceId: bot,
        chatId: from.chat,
        senderId: from.sender,
        messageId: from.message,
      },
    })
    await state.change((data) => {
      data.inputs[key].submission = accepted.submissionId
    })
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
      const inputs = Object.values((await state.read()).inputs)
      for (const id of new Set(
        inputs
          .filter(
            (input) =>
              !input.settled && input.submission !== undefined && allowed.has(input.sender),
          )
          .map((input) => input.conversation),
      ))
        watch(id)
    },
    stop() {
      stopping.abort()
      for (const { controller } of watchers.values()) controller.abort()
    },
  }
}

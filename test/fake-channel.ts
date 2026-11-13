import type {
  ChannelHost,
  ConversationId,
  ConversationOutput,
  SubmissionReceipt,
} from '../shared/channel-host.ts'

/** One platform message, as a chat platform hands it to its adapter. */
export interface FakeMessage {
  chatId: string
  messageId: string
  text: string
  senderId?: string
}
/** Assistant text the adapter sent to a chat. */
export interface Delivered {
  chatId: string
  entryRef: string
  text: string
}

/**
 * A text-only chat adapter that knows only `ChannelHost`. It owns its chat bindings, admits each platform message
 * with a request ID from the platform's IDs, and sends committed assistant text read by history cursor. A watch only
 * tells it when to read. There are no edits, streaming display, images, or model controls.
 */
export function fakeChannel(host: ChannelHost, name: string) {
  const bindings = new Map<string, ConversationId>()
  const cursors = new Map<string, string>()
  const reads = new Map<string, Promise<void>>()
  const delivered: Delivered[] = []
  async function bind(chatId: string) {
    let id = bindings.get(chatId)
    if (id === undefined) {
      id = (await host.conversations.create({ title: `${name} ${chatId}` })).id
      bindings.set(chatId, id)
    }
    return id
  }
  async function read(chatId: string, id: ConversationId) {
    for (;;) {
      const cursor = cursors.get(chatId)
      const page = await host.conversations.history(id, {
        direction: 'newer',
        ...(cursor !== undefined && { cursor }),
      })
      for (const item of page.items) {
        if (item.type !== 'assistant') continue
        const text = item.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('')
        if (text) delivered.push({ chatId, entryRef: item.entryRef, text })
      }
      if (page.scanPosition !== undefined) cursors.set(chatId, page.scanPosition)
      if (page.continuation === undefined) return
    }
  }
  /** Send what was committed since the chat's cursor; one read at a time per chat, so nothing is sent twice. */
  function recover(chatId: string): Promise<void> {
    const id = bindings.get(chatId)
    if (id === undefined) return Promise.resolve()
    const next = (reads.get(chatId) ?? Promise.resolve()).then(() => read(chatId, id))
    reads.set(
      chatId,
      next.catch(() => {}),
    )
    return next
  }
  return {
    delivered,
    bindings,
    attach(chatId: string, id: ConversationId) {
      bindings.set(chatId, id)
    },
    async receive(message: FakeMessage): Promise<SubmissionReceipt> {
      const id = await bind(message.chatId)
      return host.conversations.submit(id, {
        text: message.text,
        whenBusy: 'followUp',
        requestId: `${name}:${message.chatId}:${message.messageId}`,
        source: {
          channel: name,
          chatId: message.chatId,
          messageId: message.messageId,
          ...(message.senderId !== undefined && { senderId: message.senderId }),
        },
      })
    },
    recover,
    async recoverAll() {
      await Promise.all([...bindings.keys()].map(recover))
    },
    /** Follow a chat until `signal` aborts: each new history cursor is read; in-flight text is not shown. */
    async listen(chatId: string, signal: AbortSignal, seen?: (output: ConversationOutput) => void) {
      const id = await bind(chatId)
      let latest: string | undefined
      for await (const output of host.conversations.watch(id, { signal })) {
        seen?.(output)
        if (output.latestHistoryCursor === latest) continue
        latest = output.latestHistoryCursor
        await recover(chatId)
      }
    },
  }
}

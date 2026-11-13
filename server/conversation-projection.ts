import type { AgentState, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import { ChannelError } from '../shared/channel-host.ts'
import type {
  ConversationOutput,
  ConversationSummary,
  HistoryContent,
  HistoryItem,
  HistoryResponse,
} from '../shared/channel-host.ts'

/** Only explicitly public message kinds may expose model content. */
export function projectEntry(entry: EntryRecord): HistoryItem | undefined {
  const entryRef = String(entry.id)
  if (entry.kind === 'pi.user') {
    const message = entry.model?.find((item) => item.role === 'user')
    if (!message || message.role !== 'user') return undefined
    const content: HistoryContent[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content.map((block) =>
            block.type === 'text'
              ? { type: 'text', text: block.text }
              : { type: 'image', image: { data: block.data, mimeType: block.mimeType } },
          )
    return { entryRef, type: 'user', timestamp: message.timestamp, content }
  }
  if (entry.kind === 'pi.assistant') {
    const message = entry.model?.find((item) => item.role === 'assistant')
    if (!message || message.role !== 'assistant') return undefined
    const content: HistoryContent[] = message.content.flatMap((block) =>
      block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [],
    )
    return content.length
      ? { entryRef, type: 'assistant', timestamp: message.timestamp, content }
      : undefined
  }
  if (entry.kind.startsWith('pi.') && entry.model?.some((message) => message.role === 'user'))
    return undefined
  return { entryRef, type: entry.kind.startsWith('pi.tool') ? 'tool' : 'other', kind: entry.kind }
}

const positive = (n: number) => Number.isSafeInteger(n) && n > 0
export function historyCursor(conversationId: number, entryId: number): string {
  if (!positive(conversationId) || !positive(entryId))
    throw new ChannelError('invalid_input', 'Invalid history cursor')
  return Buffer.from(`1:${conversationId}:${entryId}`).toString('base64url')
}
export function parseHistoryCursor(cursor: string, conversationId: number): number {
  if (!positive(conversationId) || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new ChannelError('invalid_input', 'Invalid history cursor')
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const match = /^1:([1-9]\d*):([1-9]\d*)$/.exec(decoded)
  if (
    !match ||
    Buffer.from(decoded).toString('base64url') !== cursor ||
    Number(match[1]) !== conversationId ||
    !positive(Number(match[2]))
  )
    throw new ChannelError('invalid_input', 'Invalid history cursor')
  return Number(match[2])
}
export function historyLimit(limit?: number): number {
  if (limit === undefined) return 64
  if (!positive(limit) || limit > 512)
    throw new ChannelError('invalid_input', 'Invalid history limit')
  return limit
}

/** Project an already ordered scan; its last scanned record advances past hidden content. */
export function projectHistoryScan(
  conversationId: number,
  entries: readonly EntryRecord[],
  hasMore: boolean,
): HistoryResponse {
  const last = entries.at(-1)
  const scanPosition = last && historyCursor(conversationId, last.id)
  return {
    items: entries.flatMap((entry) => {
      const item = projectEntry(entry)
      return item ? [item] : []
    }),
    ...(scanPosition && { scanPosition }),
    ...(hasMore && scanPosition && { continuation: scanPosition }),
  }
}

/** Allowlist channel-visible state; never return agent configuration or live documents themselves. */
export function projectConversationOutput(
  summary: ConversationSummary,
  agent: Readonly<Pick<AgentState, 'model' | 'thinkingLevel'>>,
  live: Readonly<LiveState>,
  latestEntryId?: number,
): ConversationOutput {
  const message = live.generation?.message
  const text = message?.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  const streamRef =
    live.run && live.generation
      ? Buffer.from(`${summary.id}:${live.run.taskId}:${live.generation.attempt}`).toString(
          'base64url',
        )
      : undefined
  return {
    activity: {
      busy: !!live.run,
      ...(summary.inputAt !== undefined && { inputAt: summary.inputAt }),
      ...(summary.answerAt !== undefined && { answerAt: summary.answerAt }),
    },
    configuration: {
      ...(agent.model && {
        model: { provider: agent.model.provider, modelId: agent.model.modelId },
      }),
      ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }),
    },
    ...(latestEntryId !== undefined && {
      latestHistoryCursor: historyCursor(summary.id, latestEntryId),
    }),
    ...(streamRef && text !== undefined && { inFlight: { streamRef, text } }),
  }
}

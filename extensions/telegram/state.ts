import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { copyJson } from '@earendil-works/chord/json'
import { defineDoc } from '@earendil-works/pi-durable'
import type { Harness, Tx } from '@earendil-works/pi-durable'
import { createMemoryState } from '@chat-adapter/state-memory'
import type { StateAdapter } from 'chat'

type Input = {
  conversation: number
  message: string
  chat: string
  sender: string
  submission?: number
  settled?: true
  queueReaction?: true
}
type Delivery = { status: 'sending' | 'sent' | 'uncertain'; message?: string }
type BotState = {
  chats: Record<string, number>
  inputs: Record<string, Input>
  clears: Record<string, number>
  deliveries: Record<string, Delivery>
  restart?: { chat: string; message: string; sender: string; generation: number }
}

const Bots = defineDoc<Record<string, BotState>>({
  kind: 'telegram.bots',
  version: 1,
  scope: 'session',
  checkpointWhen: () => true,
  initial: () => ({}),
})
const Polls = defineDoc<Record<string, JsonValue>>({
  kind: 'telegram.polls',
  version: 1,
  scope: 'session',
  checkpointWhen: () => true,
  initial: () => ({}),
})
const empty = (): BotState => ({ chats: {}, inputs: {}, clears: {}, deliveries: {} })
export const botState = async (tx: Tx, bot: string) => ((await tx.doc(Bots))[bot] ??= empty())
export function ledger(harness: Harness, bot: string) {
  return {
    async read() {
      return (await harness.snapshot(Bots, context))?.[bot] ?? empty()
    },
    change<T>(use: (state: BotState) => T) {
      return harness.commit(async (tx) => use(await botState(tx, bot)), context)
    },
  }
}

/** The SDK owns polling and failed-update recovery. Store its checkpoints without keeping a second transcript. */
export function sdkState(harness: Harness): StateAdapter {
  const memory = createMemoryState()
  const checkpoint = (key: string) => key.startsWith('telegram:polling:')
  const get: StateAdapter['get'] = async <T>(key: string) =>
    checkpoint(key)
      ? (((await harness.snapshot(Polls, context))?.[key] ?? null) as T | null)
      : memory.get<T>(key)
  const set: StateAdapter['set'] = (key, value, ttl) =>
    checkpoint(key)
      ? harness.commit(async (tx) => {
          ;(await tx.doc(Polls))[key] = copyJson(value, {
            omitUndefinedProperties: true,
          })
        }, context)
      : memory.set(key, value, ttl)
  const remove: StateAdapter['delete'] = (key) =>
    checkpoint(key)
      ? harness.commit(async (tx) => {
          delete (await tx.doc(Polls))[key]
        }, context)
      : memory.delete(key)
  return new Proxy(memory, {
    get(target, key) {
      if (key === 'get') return get
      if (key === 'set') return set
      if (key === 'delete') return remove
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

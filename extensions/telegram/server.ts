import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Chat } from 'chat'
import type { Logger } from 'chat'
import { UltimateTelegramAdapter } from './adapter.ts'
import type { TelegramMessage } from '@chat-adapter/telegram'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- one bot may have only one polling process
import { acquireLock } from '@ultimate/server/lock.ts'
import { readJson } from '@ultimate/lib/json-file.ts'
import { readSecret } from '@ultimate/lib/secrets.ts'
import { userSettingsPath } from '@ultimate/lib/settings.ts'
import { isChannelError } from '@ultimate/shared/channel-host.ts'
import type { InputImage } from '@ultimate/shared/channel-host.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '@ultimate/shared/protocol.ts'
import { address, telegramChannel } from './channel.ts'
import { commandMetadata, commands, runCommand } from './commands.ts'
import { ledger, sdkState } from './state.ts'
export const reloadOnSettings = true
export const secrets = [{ name: 'TELEGRAM_BOT_TOKEN', description: 'Token for the Telegram bot' }]

export default function telegram(host: ExtensionHost) {
  let close: (() => Promise<void>) | undefined
  const stop = async () => {
    await close?.()
    close = undefined
  }
  host.onRelease(stop)
  host.onClose(stop)
  host.onReady(async () => {
    const config = await readJson<{ telegram?: { allow?: string[] } }>(
      userSettingsPath(host.userHome),
      {},
    )
    const allow = config.telegram?.allow
    const token = await readSecret(host.userHome, 'TELEGRAM_BOT_TOKEN')
    const bot = token && /^([1-9]\d*):[\w-]+$/.exec(token)?.[1]
    if (
      !Array.isArray(allow) ||
      !allow.length ||
      allow.some((id) => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))
    ) {
      host.notice('Telegram: set a non-empty telegram.allow list in user settings.')
      return
    }
    if (!token) {
      host.notice('Telegram: set TELEGRAM_BOT_TOKEN in Secrets.', {
        untilSecretSet: 'TELEGRAM_BOT_TOKEN',
      })
      return
    }
    if (!bot) {
      host.notice('Telegram: TELEGRAM_BOT_TOKEN is invalid.')
      return
    }
    const allowed = new Set(allow)
    const lockHome = join(host.userHome, '.ultimate')
    await mkdir(lockHome, { recursive: true })
    const lock = await acquireLock(join(lockHome, `telegram-${bot}.lock`), {
      pid: process.pid,
    }).catch(() => {
      // Do not let a lock failure stop the runtime, or keep polling without ownership.
      return undefined
    })
    if (!lock) {
      host.notice('Telegram: could not take the bot lock. Only one process can poll this bot.')
      return
    }
    try {
      // The SDK may include message bodies or a request URL in its metadata. Log event names only.
      const logger: Logger = {
        debug() {},
        info() {},
        warn() {
          host.notice('Telegram: the SDK reported a polling or transport warning.')
        },
        error() {
          host.notice('Telegram: the SDK could not process an update.')
        },
        child() {
          return this
        },
      }
      const adapter = new UltimateTelegramAdapter({
        botToken: token,
        mode: 'polling',
        allowedUserIds: allow,
        persistThreadHistory: false,
        longMessages: 'split',
        longPolling: {
          limit: 1,
          allowedUpdates: ['message'],
          deleteWebhook: false,
          dropPendingUpdates: false,
        },
        logger,
      })
      const state = ledger(host.harness(), bot)
      const stopping = new AbortController()
      const chat = new Chat({
        userName: 'ultimate',
        adapters: { telegram: adapter },
        state: sdkState(host.harness()),
        concurrency: 'concurrent',
        logger,
      })
      const send = async (chatId: string, text: string | { markdown: string }, replyTo?: string) =>
        (await adapter.postMessage(adapter.encodeThreadId({ chatId }), text, replyTo)).id
      const channel = telegramChannel(
        host,
        bot,
        allowed,
        (chatId, text, replyTo, signal, timeout) =>
          adapter.bounded(signal, timeout, () => send(chatId, text, replyTo)),
        {
          typing: (chatId, signal) => adapter.typing(chatId, signal),
          progress: {
            post: (from, text, signal) =>
              adapter.bounded(signal, 5_000, () => send(from.chat, text, from.message)),
            async edit(chatId, message, text, signal) {
              await adapter.bounded(signal, 5_000, () =>
                adapter.editMessage(adapter.encodeThreadId({ chatId }), message, text),
              )
            },
          },
          reaction: (from, add, signal) =>
            adapter.bounded(signal, 2_000, () => {
              const thread = adapter.encodeThreadId({ chatId: from.chat })
              return add
                ? adapter.addReaction(thread, from.message, '👍')
                : adapter.removeReaction(thread, from.message, '👍')
            }),
        },
      )
      close = async () => {
        stopping.abort()
        channel.stop()
        try {
          await chat.shutdown()
        } finally {
          await lock.close()
        }
      }
      // Poll batches can run in parallel during SDK recovery. Serialize work for each chat, not model turns.
      const handling = new Map<string, Promise<void>>()
      const handle = async (chatId: string, work: () => Promise<void>) => {
        const next = (handling.get(chatId) ?? Promise.resolve()).then(work, () => work())
        handling.set(chatId, next)
        try {
          await next
        } finally {
          if (handling.get(chatId) === next) handling.delete(chatId)
        }
      }
      chat.onDirectMessage(async (_thread, message) => {
        const from = address(message.raw as TelegramMessage, allowed)
        if (!from) return
        await handle(from.chat, async () => {
          const images: InputImage[] = []
          for (const attachment of message.attachments) {
            if (attachment.type !== 'image' && attachment.type !== 'file') continue
            const mimeType =
              attachment.mimeType ?? (attachment.type === 'image' ? 'image/jpeg' : undefined)
            if (!mimeType || !imageMimeTypes.includes(mimeType)) continue
            if (attachment.size !== undefined && attachment.size > maxImageBytes) continue
            try {
              const data = await attachment.fetchData?.()
              if (!data) continue
              const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
              if (buffer.byteLength > maxImageBytes) continue
              images.push({ mimeType, data: buffer.toString('base64') })
              if (images.length >= maxImages) break
            } catch {
              // A failed download must not discard the message text or other images.
            }
          }
          const text = message.text ?? ''
          if (!text.trim() && !images.length) return
          await channel.submit(from, text, images)
        })
      })
      chat.onSlashCommand([...commands], async (event) => {
        const from = address(event.raw as TelegramMessage, allowed)
        const command = commands.find((name) => name === event.command)
        if (!from || !command) return
        if (command === '/restart') {
          await handle(from.chat, async () => {
            try {
              await send(from.chat, 'Restarting…', from.message)
            } catch {
              // A failed reply must not prevent the requested restart.
            }
            // requestSwap stays pending on success. SDK 4.45 shutdown waits for polling handlers,
            // so the restart request must not keep this handler open.
            host
              .restart(async (generation) => {
                await state.change((data) => {
                  data.restart = { ...from, generation }
                })
              })
              .then(async (error) => {
                if (error) await send(from.chat, `Restart failed: ${error}`, from.message)
              })
              .catch(() => {
                host.notice('Telegram: restart failed. Check the host logs.')
              })
          })
          return
        }
        await handle(from.chat, async () => {
          let answer: string | undefined
          try {
            answer = await runCommand(host, channel, from, command, event.text)
          } catch (error) {
            if (!isChannelError(error) || error.code === 'unavailable' || error.code === 'internal')
              throw error
            answer = error.message
          }
          if (answer) {
            try {
              await send(from.chat, answer, from.message)
              channel.refresh(from.chat)
            } catch {
              host.notice(
                'Telegram: command reply delivery is uncertain. It will not be sent again automatically.',
              )
            }
          }
        })
      })
      await channel.recover()
      await chat.initialize()
      const current = host.system().process
      const pending = await state.change((data) => {
        const restart = data.restart
        if (!restart || (restart.generation > current.generation && !current.activationError))
          return undefined
        // Claim before sending, like final replies: a lost confirmation must not cause a duplicate.
        const claimed = { ...restart }
        delete data.restart
        return claimed
      })
      if (pending && allowed.has(pending.sender)) {
        const text =
          current.generation === pending.generation
            ? `Restarted. The shared Ultimate host is now running generation ${current.generation} (pid ${current.pid}, build ${host.build().id}).`
            : `Restart failed during activation; rolled back to generation ${current.generation}. ${current.activationError ?? 'The target generation did not activate.'}`
        try {
          await adapter.bounded(stopping.signal, 5_000, () =>
            send(pending.chat, text, pending.message),
          )
        } catch {
          host.notice(
            'Telegram: restart reply delivery is uncertain. It will not be sent again automatically.',
          )
        }
      }
      await adapter
        .publishCommands(
          commandMetadata.map(({ name, description }) => ({
            command: name.slice(1),
            description,
          })),
        )
        .catch(() => {
          host.notice('Telegram: command menu could not be updated. Use /help to see commands.')
        })
    } catch {
      if (close) await stop()
      else await lock.close()
      host.notice('Telegram: setup failed. Check the bot configuration and connection.')
    }
  })
  return defineExtension({ name: 'telegram' })
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { TelegramAdapter } from '@chat-adapter/telegram'

const requestTimeoutMs = 5_000

export class UltimateTelegramAdapter extends TelegramAdapter {
  private readonly outbound = new AsyncLocalStorage<AbortSignal>()

  // SDK 4.45 starts typing on receipt. Ultimate instead uses Pi's active submission state.
  protected override startTypingForPrivateMessage() {}

  bounded<T>(signal: AbortSignal, timeout: number, work: () => Promise<T>) {
    return this.outbound.run(AbortSignal.any([signal, AbortSignal.timeout(timeout)]), work)
  }

  protected override telegramFetch<T>(
    method: string,
    body?: Record<string, unknown> | FormData,
    request?: { signal?: AbortSignal; timeoutMs?: number },
  ) {
    const outbound = this.outbound.getStore()
    const signal =
      outbound && request?.signal
        ? AbortSignal.any([outbound, request.signal])
        : (outbound ?? request?.signal)
    signal?.throwIfAborted()
    return super.telegramFetch<T>(method, body, { ...request, signal })
  }

  protected override sleep(delay: number, signal?: AbortSignal) {
    const outbound = this.outbound.getStore()
    return super.sleep(
      delay,
      outbound && signal ? AbortSignal.any([outbound, signal]) : (outbound ?? signal),
    )
  }

  typing(chat: string, signal: AbortSignal) {
    return this.telegramFetch<boolean>(
      'sendChatAction',
      { chat_id: chat, action: 'typing' },
      { signal, timeoutMs: 1_000 },
    )
  }

  async publishCommands(commands: { command: string; description: string }[]) {
    return this.telegramFetch(
      'setMyCommands',
      {
        commands,
        scope: { type: 'all_private_chats' },
      },
      { timeoutMs: requestTimeoutMs },
    )
  }
}

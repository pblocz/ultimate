# Telegram

Telegram connects private text chats to Ultimate through Vercel Chat SDK. The extension is off by default. It uses outbound polling and works without the web listener.

## Setup

1. Create a bot in BotFather. Keep its token private.
2. Add the token as `TELEGRAM_BOT_TOKEN` in Ultimate's user secret store. Use the Secrets panel if web is enabled.
3. Add your Telegram numeric user ID to the user settings. Enable `telegram` in the same file:

   ```json
   {
     "extensions": { "enable": ["telegram"] },
     "telegram": { "allow": ["123456789"] }
   }
   ```

4. Open a private chat with the bot. Send text to start a conversation.

Use a separate bot for each polling installation. If the bot has a webhook, remove it yourself before you enable polling. Ultimate does not remove the webhook or request deletion of pending updates. If the allowlist is empty or invalid, the extension does not start. Groups, topics, bot messages, attachments, and streaming are not supported.

## Commands

| Command                             | Result                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/clear`, `/new`                    | Start a fresh conversation for this chat. Keep its persona and model selection. Keep the old history and work. |
| `/stop`                             | Stop the active run. Keep queued inputs.                                                                       |
| `/compact`                          | Compact the current context.                                                                                   |
| `/stats`                            | Show context use, token counts, and recorded cost for this conversation.                                       |
| `/model [preset or provider/model]` | Show or change the model.                                                                                      |
| `/thinking [level]`                 | Show or change the thinking level.                                                                             |
| `/persona [name]`                   | Show or change the persona. Use `none` to remove the selection.                                                |
| `/followup <text>`                  | Wait for the active run to finish.                                                                             |
| `/help`                             | Show available commands.                                                                                       |

Plain text steers a busy conversation. An idle conversation starts a turn for plain text or a follow-up. These commands do not change standing addresses or the web selection.

## Recovery limits

The channel saves the chat binding and input receipts in Pi Durable. A repeated Telegram message does not move to a new conversation after `/clear`. A reply to older work still goes to the chat that sent it. Telegram receives replies to its own inputs, not automation or background results.

If Telegram may have received a reply but does not confirm it, Ultimate reports the uncertain send and does not try again. A stop or restart during a send can cause the same result. Read the saved answer in the conversation if the Telegram reply is missing.

Disabling the extension stops polling and does not stop admitted work. A reply that has not started to send can resume after you enable the channel again, if the sender is still allowed. Pi Durable keeps the transcript. Chat SDK does not keep a second transcript.

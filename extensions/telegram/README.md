# Telegram

Telegram connects private chats to Ultimate through Vercel Chat SDK. The extension is off by default. It uses outbound polling and works without the web listener.

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

Use a separate bot for each polling installation. If the bot has a webhook, remove it yourself before you enable polling. Ultimate does not remove the webhook or request deletion of pending updates. If the allowlist is empty or invalid, the extension does not start. Groups, topics, bot messages, non-image attachments, and token streaming are not supported.

Photos and image documents pass to the model inline, with or without a caption. Supported types are PNG, JPEG, WebP, and GIF. Each message accepts up to four images, each at most 2 MiB. The extension skips unsupported, oversized, or failed image downloads.

At startup, Ultimate publishes the command list to Telegram's menu for private chats. If Telegram rejects the update, polling continues and `/help` still lists the commands.

## Turn status

- **Queued input:** If a message waits for the active run, Ultimate adds a 👍 reaction. It removes the reaction when the message starts or leaves the queue.
- **Typing:** Ultimate refreshes `typing` every three seconds while it works on a message from the chat. The signal continues during tool calls and stops after the final reply send ends. If `typing` stops before an answer and does not return, the turn stopped or the bot cannot reach Telegram.
- **Tool activity:** Each turn has at most one **Tool activity** message. Ultimate edits it as tools start and end, at most once every two seconds. It lists calls in call order, with the newest eight lines.
- **Assistant updates:** Committed assistant text between tool rounds appears as separate messages, in order, before the final answer. Thinking and partial drafts do not appear.

Tool activity uses the same hints as Nanobot: the tool and its main argument, shortened to about 40 characters. Examples are `read …/telegram/README.md`, `$ git status --short`, `fetch https://example.com/docs/page`, and `codemode("const files = …")`. Tool output and error text are not sent. A token written directly into a command or path can appear in the hint. If an edit fails, Ultimate stops progress edits for that turn and does not send a replacement.

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
| `/restart`                         | Restart the shared Ultimate host. Requires the supervisor (`pnpm start`).                                       |
| `/help`                             | Show available commands.                                                                                       |

Plain text steers a busy conversation. An idle conversation starts a turn for plain text or a follow-up. These commands do not change standing addresses or the web selection.

`/restart` first replies `Restarting…`. After activation, it reports the generation, PID, and build, or an activation failure and rollback. It does not repeat the result after an extension reload. If delivery is uncertain, it records a diagnostic and does not resend the reply.

## Recovery limits

The channel saves the chat binding and input receipts in Pi Durable. A repeated Telegram message does not move to a new conversation after `/clear`. A reply to older work still goes to the chat that sent it. Telegram receives replies to its own inputs, not automation or background results.

If Telegram may have received a reply but does not confirm it, Ultimate reports the uncertain send and does not try again. A long reply is split into several messages. If a later part is not confirmed, Ultimate does not resend the earlier parts or the missing part. A stop or restart during a send can cause the same result. Read the saved answer in the conversation if the Telegram reply is missing.

After a restart, Ultimate resumes typing for active messages. It does not post another **Tool activity** message for a run that was already active, and it does not replay missed assistant updates. A reaction can stay on a message if the stop happens while Telegram processes it.

Disabling the extension stops polling and does not stop admitted work. A reply that has not started to send can resume after you enable the channel again, if the sender is still allowed. Pi Durable keeps the transcript. Chat SDK does not keep a second transcript.

# Channel host: the conversation interface for channels

Part of the [extension guide](../../extensions/README.md). The host fields are in [server facets](server.md).

`host.channelHost()` gives a server facet a channel-facing conversation service. A channel adapter, such as a chat
platform bridge, uses it to create conversations, admit input, read history and follow output. The contract is in
`shared/channel-host.ts`. It has plain data types only: it does not import Pi Durable, Chord, pi-ai, the web SDK or
server files. A channel facet needs no core edit.

The port is a service that an adapter uses, not a base class to implement. A text adapter uses only the operations
it needs. Platform connections, external address bindings, authentication, formatting and send or edit behavior
belong to the adapter. Advanced extensions keep `harness()`; the port is not a sandbox around native calls.

## Operations

| Operation                                           | Result                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `conversations.list()`                              | The current conversation summaries, the same list as `host.conversations()`.                                               |
| `conversations.create(request)`                     | `{ id }`. See [configuration](#stop-cancellation-and-configuration). The defaults are the workspace and the default model. |
| `conversations.get(id)`                             | The summary, the model and thinking, and the selected `definition` and `preset`.                                           |
| `conversations.configure(id, change)`               | The configuration after validation and commit.                                                                             |
| `conversations.submit(id, input)`                   | A receipt `{ conversationId, submissionId }`: durable admission, not an answer.                                            |
| `conversations.submission(id, submissionId)`        | `queued`, `active`, `answered` with `answerRef`, or `unanswered` with a reason.                                            |
| `conversations.cancelQueuedInput(id, submissionId)` | Withdraws queued input, or fails with `conflict` when it has started or finished.                                          |
| `conversations.stop(id)`                            | Stops the conversation's own foreground work, and returns when it has settled.                                             |
| `conversations.compact(id, { instructions? })`      | `{ operationId }`, an opaque string.                                                                                       |
| `conversations.history(id, page)`                   | Safe history items, a scan position, and a continuation cursor when more remain.                                           |
| `conversations.watch(id, { signal? })`              | An async stream of complete output snapshots.                                                                              |
| `models.list()`                                     | Model descriptors with availability, limits, thinking levels and cost; no credentials.                                     |

IDs are positive integers, opaque to the caller and valid in this installation only. Which conversation a browser
shows is UI state; there is no server-wide selection.

## Readiness and admission

Use `onOpen` for initialization and `onReady` for listeners that accept input:

- Before storage opens, every operation fails with `unavailable`.
- In `onOpen`, reads and watches work. Mutations (create, submit, configure, stop, cancel, compact) fail with
  `unavailable`.
- `onReady` runs after the harness resumes and the shared service admits public work. Its callbacks can submit.
- A facet's `onReady` runs once in each activation, after that facet's `onOpen` callbacks succeed. It runs again on
  a core swap, and after a hot enable or reload. A registration on a ready facet runs at once.
- When an `onOpen` callback of a facet fails, that facet's `onReady` callbacks do not run in that activation.
- A failed `onReady` callback gives a diagnostic for its facet. Other facets and the runtime continue. The callback
  owner removes its partial listeners before it fails.
- Keep `onReady` finite. Do not await an endless listener or a reconnect loop in it. Do not await readiness in
  `onOpen`: that blocks the transition that it waits for.

The web and the port use the same admission check. When a core release or shutdown starts, admission closes before
cleanup. New operations and watches then fail with `unavailable`, and the web answers 503 until its admitted
requests settle; then it closes its listener. An operation that entered
before the close is checked again before its native commit, and storage stays open until it settles. Input whose
commit won the race stays admitted. A retry with the same request ID finds it.

Readiness means that the conversation service accepts work. It does not mean that every channel is connected.
Different channels have no start order; use [contracts](contracts.md) for a dependency.

## Input

- Text, with up to 4 images of `image/png`, `image/jpeg`, `image/webp` or `image/gif`, 2 MiB decoded each, in
  canonical base64. Text or an image is necessary.
- `/skill:name args` expands as it does for the web.
- `whenBusy` is omitted, `steer` or `followUp`, with the native behavior. There is no channel queue.
- `requestId` is the native deduplication key. The same ID in the same conversation returns the first receipt,
  also after a reopen. Distinct IDs with the same text are distinct inputs. Put the channel instance and the platform
  message identity in the ID; a message edit needs a new revision identity.
- `source` names the origin: `channel`, and optional `instanceId`, `senderId`, `chatId`, `threadId`, `messageId`,
  `replyToMessageId`, `device`, `login` and `address`, all strings. It is description, not authentication. It does
  not go into the model text and gives no right to call user-only actions.

After admission, the submit records a `UserInputEvent` ([events](events.md)) with the source. This event commits
after the input, not with it: a crash between them keeps the input and loses the event. Do not use the event as the
only record of a binding or a delivery.

## Stop, cancellation and configuration

`stop` stops the conversation's own foreground tasks. Queued follow-ups stay queued, and background or separately
owned work continues. `cancelQueuedInput` checks that the submission belongs to the conversation. Closing a watch
never stops a run: call `stop` or `cancelQueuedInput` for that.

`configure` uses the web's validation. An unavailable model or an unsupported thinking level is `invalid_input`. A
model change without a thinking level keeps the current level, or clamps it to the new model.

`create` and `configure` take the same selectors: `definition` (an agent definition name, or `null` for none),
`preset` (a model family name), `model` and `thinkingLevel`. `create` also takes `title` and `cwd`, and marks the new
conversation as an ordinary chat (label `chat`). A request applies its selectors in one commit, so a failure changes
nothing:

- A `definition` applies every field of that definition, as for a child: instructions, tools, model, thinking and
  summaries. Discovery, overlays, scope precedence and trust are the same as for `subagent`. An explicit `preset` or
  `model` in the same request wins over the definition's model. In `configure`, a definition (or `null`) that names
  no `model`, `family` or `thinking` keeps the conversation's model, thinking level and preset.
- A `preset` sets its model and thinking and keeps the definition and its tools. A direct `model` clears the preset.
  A request with both a `preset` and a `model` is `invalid_input`.
- An unknown definition or preset is `invalid_input`. A definition with an `isolate` mode other than `none` is
  `unavailable` when no `ultimate.conversation-isolation` backend supports that mode (`workspaces` supports
  `worktree`). A definition that needs summary control is `unavailable` when that support is absent.
- A definition change is a `conflict` on a conversation that is not an ordinary chat, during a run, or on an isolated
  conversation.

## History and cursors

History items are `user` and `assistant` items with text and images, and `tool` or `other` items with an entry
reference and kind only. Reasoning, system prompts, hidden context and tool arguments are not in history or
watches. Unknown entry kinds show their kind and reference, never their data.

- `direction: 'older'` reads newest first, before the cursor; without a cursor, from the newest entry.
- `direction: 'newer'` reads oldest first, after the cursor; without a cursor, from the first entry.
- Cursors are exclusive, opaque, and valid for one conversation. A cursor from another conversation is
  `invalid_input`.
- `limit` defaults to 64, up to 512.
- `scanPosition` moves past hidden records too, so read from it to continue. `continuation` is present when more
  entries remain.
- Cursors survive close, reopen and compaction, not a storage reset.

## Watch and recovery

A watch sends a complete snapshot at once, then a new complete snapshot when the conversation changes, whoever
started the change. A snapshot has the activity, the configuration, the latest history cursor and, while a model
writes, `inFlight: { streamRef, text }`. In-flight text is replaced by the next snapshot; it is not a delivery event.
A slow consumer gets the latest state, not every state.

Deliver committed output from history: keep a cursor for each chat, read `newer` from it when
`latestHistoryCursor` changes, and read again from it after a reconnect or a restart. Output committed while no
watch ran is found the same way. A history entry keeps its reference, so an adapter can skip what it sent.

Input admission, committed output and platform delivery are three different acknowledgements. The port gives the
first two. There is no send cursor, outbox or delivery promise.

A watch ends when its iterator returns, when its signal aborts, when its facet reloads or is disabled, and on a core
release or shutdown. Ending a watch again is safe.

## Errors

Failures are `ChannelError` with a `code`: `invalid_input`, `not_found`, `conflict`, `unavailable` or `internal`.
An `internal` failure is logged on the server, and its message has no stack or credentials.

## Lifecycle and cleanup

The port of a facet is scoped to that facet. A reload, disable or removal invalidates it before the facet's cleanup:
calls then fail with `unavailable`, its watches end, and its pending `onReady` callbacks do not run. A failed
replacement keeps the previous facet active. `host.channelHost()` always resolves the current backend, so a port kept
across a core swap uses the reopened storage.

`onRelease` runs before a core swap and `onClose` on facet cleanup and final shutdown. Final shutdown does not run
`onRelease` first, so put cleanup that both need in a function that is safe to call twice. Cleanup never cancels
conversation work: native durable shutdown and recovery own unfinished runs.

`host.notice` diagnostics are for the operator. Do not send them to a chat.

## The web

The web is a channel like the others: the optional `web` extension starts its own HTTP listener in `onOpen` and stops
it on release, through `host.webChannel()` (`server/web-channel.ts`), which only it may use. The core starts no
listener, so a runtime without the web has no open port. Local calls between extensions use `host.need`, `host.want`
and `host.invoke`, never HTTP. `/api/extensions/:name/actions/:action` is the browser's route to the same dispatcher.

The browser keeps its own private protocol: `/api/events` views, Chord operations and documents, the history
`before` and `after` parameters, and the HTTP statuses. Its conversation endpoints call the same shared operations,
so their validation, admission and events are the same. Those formats are not part of the port.

## Example

`test/fake-channel.ts` is a text-only adapter over the port, and `test/fake-channel.test.ts` loads it from a project
facet. The facet shape is:

```ts
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'

export default function chat(host: ExtensionHost) {
  const port = host.channelHost()
  host.onReady(async () => {
    // Connect the platform here; start its receive loop without awaiting it.
    // Read history from each chat's saved cursor, then follow port.conversations.watch().
  })
  host.onClose(async () => {
    // Disconnect the platform. Do not call port.conversations.stop().
  })
  return defineExtension({ name: 'chat' })
}
```

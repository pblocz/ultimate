# Server facets: host, lifecycle, tools and prompt

Part of the [extension guide](../../extensions/README.md).

`server.ts` exports a Pi Durable extension, `defineExtension({ name })` with the folder's name, or a factory
receiving the `ExtensionHost` below. See `prompt/` for prompt sections and `coding-tools/server.ts` for tools; the
root `AGENTS.md` explains reloads and durability. Local imported modules reload with the facet; a failed load leaves
the previous version installed. Besides the extension it may export `docs` ([documents](documents.md)), `actions`,
`userActions` and `pollActions` ([actions](actions.md)), `secrets` ([secrets](places.md#secrets)),
`reloadOnSettings` (below) and `order`.

## Order and prompt sections

Server facets may `export const order = -100`: lower values come first, with the default 0 keeping discovery order
(built-in → user → project, then folder name); changing it reorders the server prompt and tools once.

Prompt sections stay stable between turns: the same conversation renders the same text every time, so the prompt
stays cached. Anything that changes while a conversation runs (a count, a list, a time) goes in a per-input note
from a `beforeInput` hook instead. For example, `todos/server.ts` does not list open to-dos in a section; its
`beforeInput` returns a note only when the list changed since the conversation last saw it.

## Extension host

Server factories receive exactly these `ExtensionHost` fields (import its type only from `server/extensions.ts`):

- `ultimateRoot`, `projectRoot`, `userHome`, `home`: source, work, user and instance-state roots.
- `modelRuntime`, `settings`: Pi model/auth runtime and settings.
- `models()`: model descriptors, including availability.
- `skills(cwd)`: enabled extensions' skills, then effective-directory, user and trusted project skills. Each has `scope` and `overrides`; an extension skill also names its owner in `extension`. See [skill precedence](../settings.md).
- `restart(approved)`: request a verified core swap; the async callback records the approved generation before activation.
- `scanSubmissions(query, limit, cursor, caller)`: a page of committed submission records; it exists until Pi Durable exposes submission scans publicly.
- `chapter`: the active chapter: its name, number, the newest chapter's name and its files.
- `build()`, `system()`, `extensions()`: current build, system and extension inspection.
- `conversations()`: every conversation's summary, as `useConversations()` gives the web; empty until the harness is open.
- `channelHost()`: the channel-facing conversation service for chat adapters, scoped to this facet; see [channel host](channel-host.md). Its operations fail with `unavailable` before the harness opens, and its mutations wait for readiness.
- `projects()`: the user's central project homes read from their JSON manifests, never another project's SQLite; includes this home and live supervisor URLs.
- `projectSetup()`: whether the project has `.ultimate/` setup, the decision of its root (a linked worktree's main checkout) and its capped README.
- `projectSettings()`: the project's parsed settings, only after a local decision; otherwise empty.
- `projectExtensions()`: a read-only inventory of the project's extension folders, including replacements of active extensions.
- `setProjectDecision(local)`: remember the local/global choice and apply it through the live settings reload.
- `reloadExtensions()`: apply settings writes to the registry, browser facets and styles before returning.
- `invoke(name, action, args, signal, conversationId?)`: call an installed extension action on behalf of a conversation; rejects user-only actions.
- `harness()`, `uiState(context)`, `doc(kind)`: durable harness, root UI snapshot and exported conversation document token.
- `implement(api, value)`, `need(api)`, `want(api)`, `catalogue()`: publish and use typed process-local services; see [contracts](contracts.md). Registrations are staged until installation succeeds, replaced on reload, and removed when the facet is disabled, removed or closed; a failed replacement keeps the old provider.
- `metadata`: the core's `ultimate.metadata` conversation document, `{ title?, label? }`; the shell names a conversation
  by them, so set them on conversations you create (`subagents` labels each child with its definition).
- `emit(tx, event, data)`, `react(name, events, handler)`, `eventLog`: durable events; see [events](events.md).
- `trace`: the recorded calls (services, actions, reactor runs, tools); see [tracing](introspection.md#tracing).
- `access.allow({ origin, verify })`: register an HTTP origin with an identity verifier; returns a disposer and is automatically removed when the facet unloads or reloads. HTTP, API, and websocket upgrades use the same admission rules.
- `notice(message, { untilSecretSet }?)`: publish a warning notice and retain it in this facet's system diagnostics until unload or reload. If `untilSecretSet` names a saved secret, hide the notice from current diagnostics. Its event history stays unchanged.
- `resource(key, create)`, `onOpen(callback)`, `onRelease(callback)`, `onClose(cleanup)`: shared reload-stable resources, async work each
  time the harness opens (at once if it is open; the server serves once it settles; reads work, conversation mutations wait for `onReady`), async work each time before it closes while the process stays (a core swap; drop commit subscriptions there), and async cleanup. Facet-level callbacks are removed on unload/reload, with cleanup run before the replacement opens. Callbacks registered inside a shared resource's creation belong to that reload-stable resource and survive until server shutdown.
  Keep only process state in a resource (running children, in-flight promises, flags); never capture document or task
  tokens or facet functions in it, since they go stale on reload. Build those on each install around the shared state.
- `onReady(callback)`: finite async work each time the harness accepts public work, after this facet's `onOpen`
  callbacks succeed; start channel listeners here. See [lifecycle](#lifecycle).
- `onLoadError(callback)`: run `callback(name, error)` each time an extension's server facet fails to load; facet-scoped.
- `onBeforeLoad(callback)`: run and await `callback()` before each extension reload, web build and restart, so none reads a checkout or packages still being written (`update` waits for git and installs owed packages there). When it throws, a reload or build goes on with a notice and a restart is refused with the message; facet-scoped.

## Lifecycle

Facet-registered `onOpen` and `onClose` callbacks are facet-scoped: they end on reload, disable, or unload. An `onOpen` registered after installation while the harness is already open runs immediately. Cleanup failures produce notices and do not stop the remaining facet cleanups. Callbacks registered synchronously inside a `resource()` factory are process-scoped and survive reloads until server shutdown. Process-scoped cleanups settle independently; failures produce notices without preventing core shutdown.

Each activation has this order: the harness opens, `onOpen` callbacks run (reads and watches work, conversation mutations fail with `unavailable`), the web adapter is prepared, the harness resumes, public admission opens, then `onReady` callbacks run. `StartedEvent` commits before `onOpen` and does not mean ready. A facet's `onReady` callbacks run once in each activation and only when its `onOpen` callbacks succeeded; a hot enable or reload runs the facet's `onOpen` callbacks, then its `onReady` callbacks, and a registration on a ready facet runs at once. A failed `onReady` callback produces a notice for its facet and does not stop the runtime or other facets. Callbacks for a facet or activation that is no longer current do not run.

A core release and the final shutdown both close public admission before any cleanup. Operations that entered before then settle before storage closes; model runs and queued follow-ups are left to durable recovery. A release runs `onRelease`; final shutdown runs `onClose` without `onRelease`, so cleanup that both need must be safe to repeat. See [channel host](channel-host.md#lifecycle-and-cleanup) for channel watches.

A server facet can export `reloadOnSettings = true` to reinstall on live settings changes even when its enablement is unchanged. Its scoped lifecycle callbacks and access registrations are cleaned up before its replacement opens.

Type imports from `server/` are fine. Runtime imports need a host capability or a visible lint exception.

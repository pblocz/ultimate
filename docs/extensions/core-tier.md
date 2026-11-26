# Core tier

Part of the [extension guide](../../extensions/README.md).

The core tier is the fixed heart of Ultimate that every other extension may rely on. An extension joins it with one
line in its `api.ts`, `export const tier = 'core'` (`coreTier` in `shared/extension-api.ts`); nothing in `server/`
names them. A user or project folder is core only when it replaces a core built-in of the same name. Discovery reads
the line: a core-tier extension stays enabled whatever `extensions.disable` says (the
ignored entry becomes an extension diagnostic), and `ExtensionInfo.core` marks it, so the first-run choices and the
Extensions panel show it as `core` with a locked switch. Being always on, a core-tier service is there for every
extension: consumers `need` it. `want` is for optional extensions' services and for extension points, which another
extension fills. An optional extension can still be a required provider for another optional extension. If the
provider is disabled and its dependent stays enabled, the host reports the missing provider. It does not enable the
provider automatically. `test/e2e/disable-each.test.ts` checks both cases.

Today's core tier: agent, prompt, coding-tools, conversations, models, documents, notices, secrets, theme,
subagents, messages, onboarding (the first run, the Extensions panel and the `setup` tool), and sidebar.

Dependencies point one way. A core-tier extension imports (runtime or type), needs and wants only core-tier
extensions; lint's `core-tier-deps` enforces the imports, and the catalogue has no cycles. `pnpm deps`
(`scripts/deps.ts`, part of `pnpm check`) prints the graph between built-in extensions, from every import (runtime,
type, re-export, dynamic) and every `need`/`want` of another extension's token, and fails on a cycle or a core-tier
extension depending on an optional one. The core layers, lowest first, each depending only on layers below it:

1. prompt, coding-tools, documents, notices, secrets, theme: stand alone.
2. models.
3. conversations: titles, summaries, overview, concluding; `ConversationRef`, `FeatureTag`, `AgentMark`.
4. subagents: child conversations and standing agents.
5. messages: delivery, replies, and optional workflow points.
6. onboarding and agent. Onboarding depends only on models and secrets; its coding parts come from `coding-workflow`.
7. sidebar: the ordinary conversation list and the sidebar's points. `coding-workflow` adds the project tree.
   `supercoordinator` adds the title-bar shortcut.

Where a lower extension needs something a higher one knows, it declares the contract and the higher one fills it:
server extension points (`conversations.trees` and `conversations.release` from conversations, `workspaces.branches`
from workspaces, `messages.workflow` from messages, `subagents.workflow` and `subagents.child-operations` from
subagents, `onboarding.workflow` from onboarding), web points (`conversations.phase`, `conversations.task`, `conversations.unsummarized`,
`messages.answers`, `lineage.memory-header`, `workspaces.review`, `subagents.child-badge`, `subagents.child-result`,
`messages.agent-name`, `onboarding.setup-workflow`, `onboarding.setup-card`, `sidebar.unlisted`), or durable events (`workspaces.landed`,
`models.login-changed`). Optional extensions plug into the core the same way: phase, plan, questions, and
`coding-workflow` provide points and react to events; the core never imports them. A web point is `definePoint` in the owner's `ui.tsx`,
rendered with `<Provided>` and filled by `provides` in another facet (see
[Web points](contracts.md#web-points)).

`workspaces` and `lineage` are optional and stay enabled by default in the full checkout. `lineage` requires
`workspaces`, and `coding-workflow` requires both. Core requires neither.

`workspaces` implements the shared `ultimate.persona-application` point for ordinary chats and children. It also
implements `subagents.child-operations` for the legacy child tool routes. Neither caller imports `workspaces`. The
points are direct calls through the extension API table, not durable events.

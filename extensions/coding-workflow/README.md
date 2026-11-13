The optional `coding-workflow` extension holds the coding rules that ordinary messages and child agents do not need.

It is enabled by default in the full application, but it is not in the core tier. Ordinary conversations, child agents,
messages, and schedules continue to work when this extension is absent.

## What it owns

- The `branch` tool, coordinator selection, branch reports, and answers routed back to branches.
- The existing `board.route` and `board.notice` task kinds, versions, checkpoints, and request IDs.
- The `workspaces.branches` extension point that the Lander uses.
- Permission for `@ultimate` and branches to message the user and settle questions for the user.
- Remote-project messages and the `messages.remote` and `messages.remoteReply` implementation.
- Primary-agent notices, side-chat notes, and extra automation escalation messages.
- On-demand startup of `@ultimate` through `subagents.workflow`.
- The bundled `ultimate`, `coordinator`, `worker`, `designer`, and `reviewer` definitions in `agents/`.

The `messages` extension keeps the web action names. Its thin handlers call `messages.workflow` only after the current
permission checks. When the workflow is absent, these actions fail before they change state.

## Boundaries

Generic extensions must not import this extension's implementation. They use the optional points declared below them:

- `messages.workflow` in `extensions/messages/api.ts`.
- `subagents.workflow` in `extensions/subagents/api.ts`.
- `automations.workflow` in `extensions/automations/api.ts`.

The stored `board.started` document stays in `messages/api.ts`, so old records keep their kind and fields.

The current web app still expects this extension and the coding modules. Phase 3 will replace those screens. Do not use
the minimal server test as proof that the current web app can run without coding modules.

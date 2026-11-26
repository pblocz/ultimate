# Supercoordinator

This optional extension supplies the standing coordinator. Its default standing name is `ultimate`, so its address is
`@ultimate`. Other extensions read the role through `SubagentsApi.coordinator`. They do not use the name directly.

## What it owns

- The `ultimate` persona in `agents/ultimate.md`.
- The `subagents.workflow` provider: the standing name, on-demand start, and the saved binding.
- The `supercoordinator.binding` document, which keeps the last bound conversation ID.
- The passive branch question notes: a reactor and the `board.notice` task (`questions.ts`, `notice.ts`).
- The extra automation escalation alert: the `automation-alerts` reactor and the
  `supercoordinator.automation-alert` task (`escalations.ts`).
- The title-bar wordmark and phone button, **Talk to @ultimate** (`subagents.ultimate`, `mod+0`), and
  **Debug with @ultimate** (`ErrorReport`).

## Defaults

An explicit project or user `defaultDestination` takes precedence. If neither setting exists, the active provider
supplies its standing address. Without the provider, there is no implicit default.

## Branch question notes

`coding-workflow` emits `coding-workflow.branch-question-asked` and `coding-workflow.branch-question-resolved`. The
events carry IDs and an outcome, not text. The reactor reads the bounded message log for the text. If a message was
pruned, the note names only the message ID and the outcome. A note is a passive write. It does not start or steer a
model turn. Without a bound coordinator, the reactor writes nothing and creates no conversation.

## Automation escalation alerts

The reactor matches `automations.escalated` by name, so this extension loads without the Automations folder. For each
new event it creates one task in the reactor transaction. The task resolves the active role through
`SubagentsApi.coordinator`. If the role has no bound conversation, the task opens it on demand. The task pins the
recipient, then submits `escalationNotice` from `shared/automation-escalation.ts`. A subscriber with the same
conversation uses the same request ID, so it gets one input. If the role has moved or the conversation is gone, the
task writes nothing. A fresh reactor starts after the newest event and does not open a conversation at startup.

## Disable, removal, and re-enable

If you disable or remove the extension, the persona, address, shortcut, and notes are not available. The history stays
readable. An explicit `@ultimate` address fails and does not go to another conversation.

If you enable the extension again, an explicit open restores the last bound conversation, also after a rotation.
Startup does not create the conversation. The reactor resumes from its saved cursor. A pending `board.notice` task writes
only if its saved recipient still holds the role.

The optional `coding-workflow` extension holds the coding rules that ordinary messages and child agents do not need.

It is enabled by default in the full application, but it is not in the core tier. Ordinary conversations, child agents,
messages, and schedules continue to work when this extension is absent.

## What it owns

- The `branch` tool, coordinator selection, branch reports, and answers routed back to branches.
- The existing `board.route` and `board.notice` task kinds, versions, checkpoints, and request IDs.
- The `workspaces.branches` extension point that the Lander uses.
- Permission for `@ultimate` and branches to message the user and settle questions for the user.
- Primary-agent notices, side-chat notes, and extra automation escalation messages.
- On-demand startup of `@ultimate` through `subagents.workflow`, and its name through `coordinatorName()`. Automations, update merge, and review use that name as an optional default.
- The bundled `ultimate`, `coordinator`, `worker`, `designer`, and `reviewer` definitions in `agents/`.

The `messages` extension keeps the web action names. Its thin handlers call `messages.workflow` only after the current
permission checks. When the workflow is absent, these actions fail before they change state.

## Prompt and skills

`conduct.ts` supplies coding principles and shared-checkout advice outside ordinary chat trees.
It follows the existing `chat` label through ownership and history parents; it adds no new conversation identity.
Owned children get the principles but not the top-level checkout advice, as before.
The existing `coding_workflow` section still follows the `branch` tool.

This extension owns four skills: `how-ultimate-works`, `adopt-ultimate-setup`, `integrate-ultimate`, and `ui-preview-round`.
They live under `skills/` here. Disabling the extension removes them from later discovery.
User and trusted project skills can override them by name.

## Boundaries

Generic extensions must not import this extension's implementation. They use the optional points declared below them:

- `messages.workflow` in `extensions/messages/api.ts`.
- `subagents.workflow` in `extensions/subagents/api.ts`.
- `automations.workflow` in `extensions/automations/api.ts`.

The stored `board.started` document stays in `messages/api.ts`, so old records keep their kind and fields.

The web app runs without this extension and the coding modules. `test/e2e/ordinary-web.test.ts` proves it in Chromium:
it serves the real web shell from a copy without `workspaces`, `lineage`, `coding-workflow` and `dream`.

## Coding onboarding

The generic `onboarding` extension keeps the Get ready dialog, the Extensions panel, project trust and the `setup` tool.
This extension provides the coding parts through `onboarding.workflow` (`OnboardingWorkflow`, `onboarding/api.ts`;
`onboarding.ts` here): starting onboarding with `@ultimate`, the walkthrough, help for the project and Git cards, the
Git isolation reason and `setupGit`. The `onboarding` actions `start`, `walkthrough`, `help`, and `choose` for the Git
card keep their names and user-only checks; without this extension they fail before they change state.

In the browser (`onboarding.tsx`) it provides the Start here card above `@ultimate`'s composer, the Git setup card
(`SetupCard`), the start and help calls (`SetupWorkflow`), the **set up git** status-line reminder (`NoGit`), the
walkthrough command and the `onboarding.start` entry card. These keep their stored state and entry kinds.

## Web UI

`web.tsx` adds the coding UI through slots and the generic points:

- The project tree in the `sidebar` slot at order 100, below the ordinary conversations (`sidebar.tsx`), and the
  `Seen` overlay that records seen answers.
- The title bar's ULTIMATE wordmark (`titlebar.brand`) and, on phones, the `@ultimate` button (`titlebar.left`).
- **Talk to @ultimate** (`subagents.ultimate`, `mod+0`).
- `ErrorReport`: **Debug with @ultimate** puts an error report into `@ultimate`'s draft, unsent. It replaces the
  generic report into the selected conversation's draft, because a later extension wins a point.
- Through `workspaces`: the isolation badge and landing details on child cards (`ChildBadge`, `ChildResult`).
- Through `messages`: the Lander's name (`AgentName`).

The tree below is this extension's `sidebar.tsx` and the files it uses (`rows.tsx`, `root.tsx`, `landed.tsx`,
`lander.tsx`, `landings.ts`, `listed.ts`, `summaries.tsx`, `section.tsx`, `work.ts`, `ultimate.tsx`). Rows under
`@ultimate`'s come from the sidebar's `sidebar.under-ultimate` point. The conversations that `sidebar.unlisted` names
(the ordinary chats, side chats) are left out of every list here (`listed.ts`).

## Project tree

Every standing agent's row leads with its mark (conversations' `AgentMark`): a small tinted tile with a glyph — a brand
`U` for @ultimate (the title bar's wordmark, or its definition `title`'s first letter), a green merge for the lander,
its definition's `icon` and `tint` for any other resident, else a bot — with a presence dot in its corner (pulsing while it works or lands, amber while it
waits on you). Then its display name (its definition's `title`, else the ULTIMATE wordmark for @ultimate, `Lander`, or
the name capitalised) with `@name` small and muted. The same mark sits in the title bar's button and before standing senders in chat bubbles.

The **project** heads the tree: its path from home (or `<project> #<worktree>`, the full path on hover) with a quiet
`History #id` on the right, and its root's **Memory** row under it, as one block. Clicking the path opens the root's
History, the project's read-only tally. A chevron before the path folds the block to that one row (folded by default,
kept in `ext.conversations.projectOpen`); folded, a quiet brain and memory count on the right of the path row opens
Memory instead.

The sidebar also stands beside lineage's Memory surface, so rows open conversations through the sidebar's `useShell`,
which brings the Agent surface back; beside Memory no conversation row is highlighted, the Memory row (or the folded
block's brain) is.

@ultimate has its own section below the project: its row shows `working`, `idle` or an amber
`N waiting on you` (reply-enabled messages to you still waiting on your answer, plus one for its current final
answer when that asks you questions), and the age of its latest
message. Clicking it opens @ultimate on the Agent surface through `subagents.standing {name: 'ultimate'}`, also before
its conversation exists. Below it, an Agents group lists the lander first, then the other ownerless top-level standing
agents (label `agent`) by ID. These rows are never concluded or hidden and show no summary or feature:
@lander shows its state (`landing` or `idle`), `queue N` while submissions wait,
and the age of its latest landing (what landed is its Landed section's first row); other agents show `working` or `idle` and the age. Their menu only
compacts the context; they are never renamed, cleared or concluded.

Beyond a phone the title bar's ULTIMATE wordmark (`titlebar.brand`) opens @ultimate too.
@ultimate's mark and line (`waits on you`) are amber while questions wait on you; the Inbox row under it says how many
and lists them (`extensions/inbox`). On
phones, where the sidebar is hidden, the title bar's `@ultimate` button (`titlebar.left`) opens @ultimate from every
surface instead, with the same mark: its dot pulses while @ultimate works and is amber while questions wait.

Every section of the sidebar folds the same way (`Section`, `section.tsx`): a quiet mono heading with a chevron and
a count bubble, open by default, its fold state kept per section in `ext.conversations.closedSections`; the Scheduled
section of the `sidebar.top` slot draws the same heading. Top to bottom:

- **Project**: the chevron, the path, opening History, and the Memory row (or, folded, its brain count).
- **@ultimate**, then the **Agents** group: the lander first, with its **Landed · N** section right under its row,
  aligned with the other sections, then other standing agents.
- **Landed**: the latest landings of every root (lineage's `recent {id, types: ['landed'], limit: 20}`), newest
  first, all landings of one feature folded into one row: its feature tag (its title when it has none), `×N` when it
  landed more than once, the commits summed, and the age of the newest. Clicking the row opens the branch that landed
  it (the landing's `from`), else the root at its landing note. The commit count opens the range in Review when the
  group's landings follow each other on the target (else plain), with the DiffsHub compare as a small ↗ for a single
  landing (`CommitCount` from workspaces). The first five show; `+N more` unfolds the rest
  (`ext.conversations.landedAll`). Landings are read again whenever a root's token count changes, which every new
  entry does.
- **Memory** (inside the project block): one row per root (`MemoryRow`, `root.tsx`) with a brain mark, the brief's size (what every new branch
  starts from; the whole context's while it has no memories) and its memories counted by kind (`4 decisions · 5 facts
  · 3 lessons`). Clicking it opens lineage's **Memory** surface, grouped into decisions, facts and lessons (empty
  until @ultimate remembers something), and the row shows selected while it is open. The project path above it opens the root's tally, the browsable history (every
  branch, abstract and landing). The row has no menu; a root is never renamed, cleared or concluded here.
- The `sidebar.top` slot: background work that optional extensions contribute without the sidebar importing them,
  automations' **Scheduled**, up to five compact rows with `+N more`, and its own
  bottom rule. Each hides while it has nothing active.
- **In flight · N** (`InFlight`, `root.tsx`): every open branch of every tree, newest input first. A branch is open
  until it is concluded or it landed after its latest input (the lander's results, or a root landing note from it;
  a landed branch that gets new work is open again). Each shows its title, its feature tag, a state (`submitted` or
  `landing` while the lander has it, the working phase while it works, amber `awaiting @ultimate` while a
  reply-enabled message it sent @ultimate is open, red `failed`, else `idle`) and its age; clicking opens it, and its `…` menu is the same as an Earlier row's (Rename, Compact
  context, Conclude with the pending-work check). A branch
  with a worktree also shows its work so far on a quiet line below (workspaces' `progress`): `N commits` not yet on
  its target, opening `branch:<name>` in Review, and `+ N edits` (uncommitted changed paths), opening
  `uncommitted:<id>`. A fresh worktree, or a branch without one, shows nothing. All rows are read in one call, again
  only when an agent commits (`coding-tools.committed`), a worktree's state changes or a branch's run starts or ends;
  never on a timer. When its coordinator works its current epic itself (no task linked to a subagent), a line
  `E1 · <title>` comes first (`EpicLine`, `rows.tsx`, from plan's `conversations.epic` point): its dot pulses while
  the coordinator runs, it reads `idle` between runs and `done` with a check once the epic is, and a click opens the
  epic in the plan panel. Its subagents follow, one line each at any depth (`SubagentLine`, `rows.tsx`): their mark, plan
  chip, role and `#id`, and their state word, with the latest activity or plan task on hover.

Landed branches and older conversations that are neither roots nor branches live in the collapsed "Earlier · N" group,
above "Concluded · N". There, branches nest under their source (`branchOf.conversationId`), with a hairline guide
and one indent per depth; siblings sort by latest input. Isolated rows carry a short `#<conversationId>` badge;
Workspace details in their menu opens Info's Workspace section. The shown row is highlighted, also while one of its
subagents is shown. Each row has its title (or `#id` for shared rows, `Untitled conversation` for isolated rows)
and the time of its latest message (`now`, `5m`, `3h`, `2d`,
then a date). Its leading mark pulses while it or any of its subagents works, and is solid when an answer arrived
since you last looked at it. Actual foreground tasks and live run boundaries determine Working, not the potentially
lagging title/timestamp list.
A solid purple dot means an unread reply, not ongoing work; only the pulsing dot means working.

Every row reads one state from messages’ `conversationState`, the same the System surface shows: working;
**waits on you** (@ultimate or a branch with an open question to the user);
**awaiting @ultimate** (amber question mark, never on a subagent: an open reply-expected message the conversation sent
the primary agent); **done** (green check, subagents only: it answered, and its answer went to its parent);
**failed** (red cross: its latest input ended unanswered); else idle. Working includes queued input. Standing rows,
the In flight list (after the lander's submitted/landing) and the System lanes show the same state. Nothing
here is a model's opinion of a reply.

A conversation with genuinely owned children has an expandable Sub-agents group; a listed root shows none, since a
root runs no turns and its children predate its tally (they stay reachable by link and search). Rows show the recorded agent role/name,
its state (Working, Done, Failed or Idle, as above), and a brief what-it-did description of its latest reply.
During new work, an old activity is labeled Last reply.
A child linked to a plan task leads with the plan's `TaskChip` and shows the task title instead of its activity.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

@ultimate starts coordinator branches; there are no manual creation commands or isolation preferences. The sidebar
header names the project's path (`<project> #<worktree>` in a branch checkout), the full path on hover; Info's first
section lists the checkouts.
Conclude releases clean, fully landed checkouts, including owned subagent checkouts. Uncommitted files,
unlanded commits, and busy checkouts are kept.
Info's Workspace section shows checkouts read-only.

Hovering a branch's row (In flight, Earlier, Concluded) for a moment opens its summary history (`summaries.tsx`): the
latest summary first, older ones below with their time, in a list capped in height that scrolls inside, also with ↑/↓
while the row has focus. It reads the conversations `summaries` action only when it opens. Standing agents, roots and
subagents have no summary, so their rows get none; touch devices have no hover and show none.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Compact context (keeps the gist and frees context;
disabled while the conversation works), and Conclude. Before concluding, the UI calls workspaces `pending {ids}`.
When a conversation or its subagents have uncommitted files or unlanded commits, a confirmation dialog names the
work and explains that its checkout is kept until the work lands or is discarded. Otherwise it concludes at once.
Concluded rows and their branches/subagents sit in a collapsed "Concluded · N" group at the bottom.
Resume brings them back. Any input that starts a run in a concluded conversation (typed input, a message or
reply, a subagent report, an automation's message) resumes it and its concluded ancestors in the commit that places
the input, through the patched `GenerationTask.beforeInput` hook. Notes and other writes start no run and resume nothing.
Concluding the shown subtree shows another live conversation when one exists.

Commands, under Conversations: `conversations.summary-model` ("Summary model…", see [Summary model](../conversations/README.md#summary-model)). The UI state keeps concluded
ids in `ext.conversations.concluded` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.

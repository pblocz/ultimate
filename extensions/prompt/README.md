Ultimate's system prompt: runtime guidance, project context, skills, and the source reload layers.

The environment section names the effective working directory, shared workspace, and installed application. Its paths
and commands refer to the server process environment, which can be a container, not necessarily the physical host.
These labels impose no new file-access restriction and do not require a Git checkout.

The system prompt stays the same across builds, so a reload of an extension keeps the prompt cache. Instead, the input that starts a
conversation's run gets a `prompt.build` note when the build differs from the one its last run started on: "Build
changed: <old> → <new> · generation N · changed: …". The note is decided in the commit that places the input (the
patched `beforeInput` hook), and the `prompt.build` document records the last build each conversation saw. A new
conversation records its first build silently, and a fork starts from its parent's.

The prompt's `identity` section names no role: "You are an assistant running in a durable agent runtime. Your selected
agent definition supplies your role and instructions." The selected definition (`Profile`) supplies the role. The
`coding-workflow` extension adds its rules in a `coding_workflow` section, which only agents with the `branch` tool get.

A top-level conversation with a selected definition also follows its instructions there: an ordinary chat (label
`chat`) or a standing agent such as @ultimate (label `agent`). Forks and children (a conversation with an owner or a
parent) keep the instructions they started with. When the definition's text differs from the conversation's, the
hook re-applies only the instructions, so a typed input picks up an updated definition file, for example
`extensions/coding-workflow/agents/ultimate.md`, as Messages deliveries already did. Model, thinking and tools stay as
chosen. With worktree support, the text includes the worktree's instructions (`conversations.worktrees`). If the
definition is gone, the hook keeps the configuration and writes a notice. The document keeps a hash of each project context file (`AGENTS.md`) and of the
clone's `AGENTS.md`, `docs/*.md`, `agents/*.md`, and enabled extensions' `agents/*.md`, and the note names the definition re-applied and the files changed
since the last run ("Instructions changed: … · Docs changed: …").

A build note also names what landed: the document keeps the clone's commit each run started on, and the first-parent
commits since then, grouped by the branch that made them (a lander merge's `from #N`, else the `Ultimate-Conversation`
trailer, a subagent under its owner), become "landed: <branch title> (#N), …". A commit made outside Ultimate is named
by its subject; a reload without commits (a hand edit in the clone) names none.

The transcript shows every note as one quiet divider: "↻ Reloaded · <branch> #N · <branch> #M · +K more" with links to
the branches, else "↻ Reloaded · build a → b" or "↻ Instructions changed · …", its full text on hover. `self`'s
update toast names the landing likewise ("Landed <branch>") when a `workspaces.landed` event comes within a minute
of the page switching to a new web bundle.

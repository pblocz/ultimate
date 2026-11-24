Git support for the user's repositories. It does not inspect Ultimate's own source; that is `source-git`.

## What it provides

- **Bash instrumentation.** It provides the `coding-tools.bash` point (`BashInstrumentation` in
  `extensions/coding-tools/api.ts`). For each `bash` call it adds process-local Git config hooks:
  - Commits made through `bash` get an `Ultimate-Conversation: <id>` trailer. Existing attribution stays when a commit
    is rebased, cherry-picked or amended. Commits outside the tool and the repository's hook files are not changed.
  - Each commit made through `bash` is recorded as the durable event `coding-tools.committed`: the conversation, the
    full sha, its parents, the repository, the linked worktree and branch, the subject, and `rewrittenFrom` for an
    amend or rebase. The `post-commit`, `post-applypatch`, `post-merge` and `post-rewrite` hooks append to a temp log
    unique to the call, and every hook ends in `|| true`. When the call ends, also after an error or a timeout, the
    instrumentation reads and removes the log and emits one event for each commit. A merge counts only when it made a
    merge commit. Commits made during a rebase have no `branch`, because HEAD is detached.
  - The events commit right after the call, not in the tool result's commit. A crash between the Git commit and that
    commit loses the event; the trailer stays.
  - An `interruptible` command that runs `git push`, `git commit` or `git merge` is refused, so a steer cannot cut it.
  - An instrumentation failure is logged and does not replace the Bash result.
- **Worktree identity** (`worktree-identity.ts`). The installation's startup module (`ultimate-startup.json`, see
  `docs/settings.md`) maps a registered linked worktree to its main checkout, so the worktree shares the main
  checkout's trust and saved presets. It requires the gitdir under `<common>/worktrees` and a matching backlink, and
  otherwise returns the directory itself.
- **Helper package** (`support/`, package `ultimate-project-git-support`): the `git` wrapper and the checkout, GitHub,
  backup identity, token weight and reset report helpers. Other extensions declare it in their `package.json`.

Commit attribution needs Git 2.54 or newer: older Git silently ignores config-based hooks.

## Switches

- `extensions.disable: ["project-git"]` turns off the Bash instrumentation at runtime. A Bash call that started
  before the change keeps its own tracker until it ends.
- Worktree identity follows `ultimate-startup.json`, not the disable switch. Remove the `projectIdentity` entry and
  restart to key projects by their own directory.
- The helper package is installed, not enabled. Its consumers work whether this facet is on or off.

Without the Bash provider, `bash` adds no Git hooks. Commits get no trailer or event from Ultimate. Without the startup
module, a linked worktree is a project of its own.

`bash` has an optional instrumentation point, `coding-tools.bash` (`BashInstrumentation` in `api.ts`). A provider
prepares each call's execution and finishes it when the call ends, also after an error or a timeout. The tool takes the
provider when the call starts, so a reload or disable during the call does not change it. A provider failure is logged
and does not replace the Bash result. `project-git` provides it: commit trailers, the durable event
`coding-tools.committed` (`refs.ts`) for each commit made through `bash`, and the refusal of interruptible Git
commands that change things. See [project-git](../project-git/README.md). Without a provider, `bash` adds no Git
config and records no commits.

Pi's coding tools and how the transcript shows them: `read` as a numbered, highlighted excerpt; `write` with its size and content; `edit` as a unified diff with old and new line numbers; `bash` as a terminal with streamed output, exit status, and duration. `bash-command.tsx` parses the command with [unbash](https://github.com/webpro-nl/unbash) (display only): the card stays collapsed once finished (open while running or failed) and its header condenses the command to its programs: pipes as arrows, list operators between steps, repeats folded (`sed ×2 · rg → head`), a heredoc's target file, and a literal leading `cd` as the directory on the right. Expanded, each step gets a highlighted row and every heredoc body is highlighted by its target file or interpreter. Unparsable commands stay raw.

Bash calls without `timeout` have a 600-second tripwire ceiling. `ULTIMATE_BASH_TIMEOUT` overrides that default
in seconds and is read at each call; it must be positive and finite. A tripwire timeout stops the process and reports
how to request a longer explicit timeout. Explicit timeouts retain Pi's ordinary timeout error.

A bash call with `interruptible: true` (waits and polls: CI checks, deploys, a file appearing) ends early when a steer
is queued in its conversation: the tool watches the conversation's `pi.inbox` and cancels the command, which kills its
process, then returns the output so far followed by "[Interrupted by a steering message after Ns; …]" (last, so
tail truncation keeps it) as an ordinary result, so the run goes on and the steer is placed at the next boundary
instead of after the wait. Follow-ups never interrupt. A marked command that changes things (an `install` or `migrate` word, or what the
instrumentation provider names, such as `git push|commit|merge`) is refused with a hint to split it, so a steer can
never cut it mid-way.

Any running bash call can be cancelled from its card (the × next to its timer): the user-only action
`cancel {callId}` (`refs.ts`) records the call in the conversation's durable `coding-tools.cancelled` document, which
every bash call watches like the inbox above, so a cancel reaches a call started before an extension reload. The call
kills its command and returns the output so far followed by "[Cancelled by the user after 5m 09s; …]" as an ordinary
result; the run goes on and the card shows `cancelled`. A restart ends a running call anyway (Pi recovers it as
interrupted). Calls never remove their own marks, since one can land as a call ends; each cancel drops the marks of
calls no longer running, and a cancel of a call that is not running fails.

Pi's `prepare` hook only changes the command, cwd, and environment, not the timeout, so one wrapper injects the
default and formats execution timeout errors.

Bash commands start with `unset NODE_ENV`. The host's Vite server sets `NODE_ENV=development`
whenever it is unset, and every shell would inherit it: a project's tests would then run in development mode, unlike
in the user's own terminal or CI.

`server.ts` installs Pi Durable's read, write, edit, and bash tools (named `coding-tools`, like this folder). `web.tsx` registers one renderer per tool name under `tools`; `diff.tsx` turns the edit tool's `details.patch` (or Pi's display `details.diff`) into rows.

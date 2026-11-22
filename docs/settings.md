## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Enabled extensions may ship `agents/` definitions, loaded as built-ins before user and project definitions or overlays.
Disabling the extension removes its definitions too.
Skills use [Agent Skills](https://agentskills.io) folders with a `SKILL.md`, as Pi loads them.
They load from enabled extensions' `skills/<name>/` folders, then the effective working directory's `.pi/skills/`,
then `~/.ultimate/skills/`, and finally the trusted project's `.agents/skills/` and `.ultimate/skills/`.
A later skill replaces an earlier skill with the same name.
Extension skills follow discovery order: built-in, user, project; names sort within each source.
Facet load priority does not change this order.
The installed application's top-level `skills/` folder no longer loads.
Disabling or removing an extension removes its skills from subsequent discovery, not from existing history. Every agent's
system prompt lists each skill's name, description and path after the project context, and the agent reads `SKILL.md`
when a task matches. `disable-model-invocation: true` leaves a skill out of that list. The persona editor's **Skills** field
can narrow the list. The expanded Agent card shows the listed skills. The user runs one with
`/skill:name request` in the composer or ⌘K → Run a skill: the server sends the skill's body in Pi's `<skill>` block
ahead of the request. The Info tab lists skills with their scope (`extension`, `user`, or `project`), owner, overrides and Pi's load warnings; a read of a
`SKILL.md` shows as `skill <name>` in the transcript. Personal instructions load from `~/.ultimate/AGENTS.md`
(or `CLAUDE.md`) ahead of the project's. Pi's own `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` and the shared
`~/.agents/skills/` are not read: they belong to other agents, so link a skill into `~/.ultimate/skills/` to use it here.
In this container, built-in skills live below `/opt/ultimate/extensions/<owner>/skills/`.
Personal skills live in `data/.ultimate/skills/`, mounted at `/home/node/.ultimate/skills/`.
Workspace skills live in `data/workspace/.ultimate/skills/`, mounted at `/workspace/.ultimate/skills/`.
These are separate folders; the loader does not copy files between them.
The existing bundled skills belong to `coding-workflow` and `self`, and follow those extensions' enabled state.

Built-ins are on by default, including `web` (the browser channel and its loopback listener; off, nothing listens), `messages` (durable agent messages and @ultimate's messages to you), `questions` (answer cards for @ultimate's questions to the user), `lineage` (conversation trees: roots, branches, notes) and `update` (tells you when the Ultimate clone is behind `origin`, checked hourly). The ones that need something of their own ship installed but off (`defaultOff` in `shared/extension-api.ts`): `cloud` (backups; your own backup Worker), `parallel` (web tools; a Parallel API key), `tailscale` (remote access; Tailscale on this machine), `health` (provider health), `classify` (Jev typed judgments; a Jev key), `phase` (working phases; requires `classify`), `sounds` (notification sounds), `voice-live` (live voice relay; an OpenAI API key and microphone), `push`, and `wire` (keeps each conversation's raw model requests and responses on disk; System's Wire tab). `recall` (project memories recalled for @ultimate's messages) is on but idle until `classify` is. The first-run extensions card and the Extensions tab turn them on in user settings. Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension outside the core
tier, while a core-tier name (`onboarding`, `subagents`, `lineage`, …) is ignored with a notice. Unknown names
produce a notice. To skip onboarding on a machine whose user knows Ultimate, set `"onboarding": false` in
`~/.ultimate/settings.json` (user settings only): no Get ready, no Start here, no setup cards and no "set up git"
reminder, while the Extensions panel and ⌘K Get ready… stay available and an undecided project setup keeps its
status-line reminder. Model families (⌘K Model families…, `extensions/models/README.md`) are kept per project in
`~/.ultimate/model-families.json`, with the most recently saved ones as the start for projects without their own; a
user's `.ultimate/settings.json` `modelFamilies` supplies defaults below the recent and project layers. The
project's `.ultimate/settings.json` `modelFamilies` is the team's default: it applies over that start, and a person's own families for the project apply over it. `summaryModel` (`"provider/id[:thinking]"`; project over user; without it the
summaries family's model, by default the tiny family's `openai-codex/gpt-6-luna:low`)
pins the model for automatic titles, summaries, reply summaries and tree abstracts. Set it in either file or with
the "Summary model…" command, and it applies to the next request. `fastModels` (`["openai-codex/<id>", …]`, or `openai/`; project over
user) runs those models on the priority tier through the `fast` extension, at a higher usage rate. `instance.model`
(`"provider/id"`, project over user, default the previews family's model, the fast family's `openai-codex/gpt-6.1-sol`; `null` turns it off) is the one model every
agent in a preview (`instance start`) runs on, fast tier included; see `extensions/instance/README.md`.
`defaultDestination` supplies a fallback for background work that has no recipient. Set it in `~/.ultimate/settings.json` or in a trusted project's `.ultimate/settings.json`. The trusted project value takes precedence.

```json
{
  "defaultDestination": { "kind": "conversation", "address": "@neutral" }
}
```

Use the name of an existing resident definition, a conversation ID such as `12`, or `"#12"`. This setting does not select a model or change a conversation's persona. Without the setting, `coding-workflow` supplies its coordinator when enabled. An invalid setting reports a notice without falling back to another recipient. A `channel` destination is not supported yet. Existing automation recipients and bound goals do not move when the default changes.

Compaction thresholds come from Pi's settings (`~/.pi/agent/settings.json`, then `<project>/.pi/settings.json`,
key `compaction`: `enabled`, `reserveTokens`, `keepRecentTokens`) over Pi Durable's defaults (reserve 16k, keep 20k,
background compaction 32k below the blocking threshold), which suit a ~200k window. `server/harness.ts`
(`compactionProfile`) sets values by each model's context window: windows of 500k and of 1M or more keep more
recent context and start compacting in the background earlier. `compaction.modelOverrides` in those settings files, keyed by exact `"provider/modelId"` (fields
`reserveTokens`, `keepRecentTokens`, `backgroundTokens`, `enabled`), replaces them field by field. Pi's settings files
are read when the server starts.
`ULTIMATE_USER_HOME` selects Ultimate's user configuration; it does not redirect Pi credentials or change `HOME`.
`ULTIMATE_HOME` selects runtime state without changing configuration scopes or trust. Relative overrides resolve against
the launch directory; startup and maintenance commands share these rules. See [Workspace and state paths](running.md#workspace-and-state-paths).
A project's `isolates.worktree` sets its checkouts' `setup` commands and, optionally, where they live (`path`) and
how they are made and removed (`add`, `remove`); see `extensions/workspaces/README.md`.
This repository's `.ultimate/settings.json` holds its isolate setup,
lander checks and preview model.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.

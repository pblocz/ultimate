Git status for Ultimate's installed source, and the changes that landed between builds. It does not inspect the
agent workspace or depend on `project-git`.

- **Source status.** It provides `ultimate.source-status` (`SourceStatusApi` in `shared/source-status.ts`): the
  branch, the short sha and whether the source checkout is dirty. System status shows it in `code`, with
  `sourceAvailable: true`.
- **Landing details.** It provides `prompt.build-details` (`BuildDetails` in `extensions/prompt/api.ts`). When the
  build changed, `prompt` asks it for the commits between the previous and the current `HEAD`, and the build note
  names them by conversation title or subject (`landings.ts`).
- It reports nothing when `ultimateRoot` has no `.git`, so an unpacked installation inside another repository does not
  report that repository. It runs Git only in `ultimateRoot` (`git.ts`, a private copy of the wrapper).

`extensions.disable: ["source-git"]` turns it off at runtime. Without it, system status shows
`sourceAvailable: false` with an empty branch and sha, and build notes have no landing details. Missing Git history
never blocks user input.

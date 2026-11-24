// Checks the Pi couplings listed in docs/pi-upstream.md: every listed file is tracked and carries a
// `Pi upstream: @earendil-works/<pkg>@<version>` marker, and every tracked marker names the installed version and its
// file is listed. Runs in `pnpm check` so a new coupling fails in the worktree, not minutes later in the lander.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const root = new URL('../', import.meta.url)
const doc = 'docs/pi-upstream.md'
const reference = readFileSync(new URL(doc, root), 'utf8')
// Untracked files count too, so a new test fails `pnpm check` before it is committed.
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)
const tracked = new Set(files)

// Each entry names its file first ("- `path` — …"); backticks later in the prose are not paths.
const borrowed = new Set(
  reference
    .split('## Borrowed from Pi\n')[1]
    .split('\n## ')[0]
    .split('\n')
    .flatMap((line) => line.match(/^- `([^`]+)`/)?.[1] ?? []),
)
const marker = /Pi upstream: (@earendil-works\/[\w-]+)@([\d.\w+-]+)/g
const installed = new Map<string, string>()
const problems: string[] = []
// Workspace packages own their own dependencies, such as `extensions/claude-code`'s pi-claude-code.
const importers = [
  ...(readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')
    .split(/^packages:\n/m)[1]
    ?.matchAll(/^  - (.+)$/gm) ?? []),
].map(([, path]) => path)

/** The installed version of `pkg`: from the marker file's folder up to the root, then from any workspace package. */
function installedVersion(file: string, pkg: string) {
  const folders: string[] = []
  for (let folder = dirname(file); folder !== '.'; folder = dirname(folder)) folders.push(folder)
  const found = [...folders, '.', ...importers]
    .map((folder) => new URL(`${folder}/node_modules/${pkg}/package.json`, root))
    .find((url) => existsSync(url))
  if (!found) throw new Error(`${file}: ${pkg} is not installed`)
  return (JSON.parse(readFileSync(found, 'utf8')) as { version: string }).version
}

for (const file of borrowed) {
  if (!tracked.has(file)) problems.push(`${file}: no such file; remove its stale ${doc} entry`)
  else if (!readFileSync(new URL(file, root), 'utf8').match(marker))
    problems.push(`${file}: listed in ${doc} but has no "Pi upstream: @earendil-works/…" marker`)
}
for (const file of files) {
  const text = readFileSync(new URL(file, root), 'utf8')
  for (const [, pkg, version] of text.matchAll(marker)) {
    const key = `${dirname(file)} ${pkg}`
    if (!installed.has(key)) installed.set(key, installedVersion(file, pkg))
    if (version !== installed.get(key))
      problems.push(
        `${file}: marker names ${pkg}@${version}, installed is ${installed.get(key)}; recheck it`,
      )
    if (!borrowed.has(file))
      problems.push(`${file}: couples to ${pkg}; document it under "Borrowed from Pi" in ${doc}`)
  }
}

if (problems.length) {
  console.error([...new Set(problems)].map((problem) => `✗ ${problem}`).join('\n'))
  process.exitCode = 1
} else console.log(`✓ ${borrowed.size} Pi couplings listed in ${doc}, each present and marked.`)

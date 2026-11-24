import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './run.ts'

/** Worktrees with uncommitted changes and `ultimate/*` branches not merged into HEAD: work the reset leaves in place. */
export async function unlanded(home: string, project: string) {
  const dirty: string[] = []
  const worktrees = join(home, 'worktrees')
  if (existsSync(worktrees))
    for (const name of await readdir(worktrees)) {
      const path = join(worktrees, name)
      const status = await git(path, 'status', '--porcelain').catch(() => '')
      if (status) dirty.push(path)
    }
  const branches = (
    await git(
      project,
      'branch',
      '--no-merged',
      'HEAD',
      '--format=%(refname:short)',
      'ultimate/*',
    ).catch(() => '')
  )
    .split('\n')
    .filter(Boolean)
  return { dirty, branches }
}

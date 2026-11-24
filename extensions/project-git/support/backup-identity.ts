import { githubRepo } from './github.ts'
import { git } from './run.ts'

/**
 * The project's global identity: its origin's GitHub key and the repository's oldest root commit. A worktree reads its
 * main checkout's origin. Undefined without a GitHub origin.
 */
export async function projectIdentity(
  root: string,
): Promise<{ key: string; rootCommit: string } | undefined> {
  try {
    const key = await githubRepo(root)
    if (!key) return undefined
    // rev-list lists newest first; a merged unrelated history adds roots, and the oldest stays the same.
    const rootCommit = (await git(root, 'rev-list', '--max-parents=0', 'HEAD')).split('\n').at(-1)!
    return { key, rootCommit }
  } catch {
    // No repository, no origin remote or no commit yet: the project has no global identity.
    return undefined
  }
}

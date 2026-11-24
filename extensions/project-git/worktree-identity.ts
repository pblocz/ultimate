import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function metadata(file: string) {
  const type = lstatSync(file)
  if (!type.isFile() || type.size > 16 * 1024) return undefined
  return readFileSync(file, 'utf8').trim()
}

/** Share trust and saved presets only for a worktree registered in its main checkout. */
export default function worktreeIdentity(root: string): string {
  try {
    const link = join(root, '.git')
    const target = metadata(link)?.match(/^gitdir: ([^\r\n]+)$/)?.[1]
    if (!target) return root
    const gitdir = realpathSync(resolve(root, target))
    const commonLink = metadata(join(gitdir, 'commondir'))
    if (!commonLink) return root
    const common = realpathSync(resolve(gitdir, commonLink))
    if (basename(common) !== '.git' || dirname(gitdir) !== join(common, 'worktrees')) return root
    const backlink = metadata(join(gitdir, 'gitdir'))
    if (!backlink || realpathSync(resolve(gitdir, backlink)) !== link) return root
    return dirname(common)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return root
    throw error
  }
}

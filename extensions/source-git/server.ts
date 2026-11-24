import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { BuildDetails } from '@ultimate/ext/prompt/api.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { SourceStatusApi } from '@ultimate/shared/source-status.ts'
import { git } from './git.ts'
import { landings } from './landings.ts'

export default function sourceGit(host: ExtensionHost) {
  const root = host.ultimateRoot
  // An unpacked installation inside another repository must not report that repository's status.
  const hasCheckout = () => existsSync(join(root, '.git'))
  host.implement(SourceStatusApi, {
    async read() {
      if (!hasCheckout()) return undefined
      try {
        const branch = await git(root, 'branch', '--show-current')
        const sha = await git(root, 'rev-parse', '--short', 'HEAD').catch(
          // An unborn branch has a name and status, but not a commit.
          () => '',
        )
        const dirty = (await git(root, 'status', '--porcelain')).length > 0
        return { branch, sha, dirty }
      } catch {
        // Git may be missing or the source checkout unavailable.
        return undefined
      }
    },
  })
  host.implement(BuildDetails, {
    async read(previous, changed) {
      if (!hasCheckout()) return undefined
      const head = await git(root, 'rev-parse', 'HEAD').catch(
        // An unavailable revision is not a build-note failure.
        () => undefined,
      )
      if (!head) return undefined
      const landed =
        changed && previous && previous !== head
          ? await landings(root, previous, head, host.conversations()).catch(
              // A previous revision can disappear after history is rewritten.
              () => [],
            )
          : []
      return { head, landed }
    },
  })
  return defineExtension({ name: 'source-git' })
}

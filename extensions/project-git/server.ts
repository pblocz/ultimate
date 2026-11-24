import { defineExtension } from '@earendil-works/pi-durable'
import { BashInstrumentation } from '@ultimate/ext/coding-tools/api.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { trackBashCommits } from './bash.ts'

export default function projectGit(host: ExtensionHost) {
  host.implement(BashInstrumentation, trackBashCommits(host))
  return defineExtension({ name: 'project-git' })
}

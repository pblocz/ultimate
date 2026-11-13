import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Started } from '../messages/api.ts'
import type { Message, Remote } from '../messages/api.ts'

/** The branch starter that receives its final answers. */
export async function starterOf(host: ExtensionHost, id: number | 'user', ctx: Context) {
  if (typeof id !== 'number') return undefined
  return (await host.harness().snapshot(Started, id as ConversationId, ctx))?.by
}

/** The request a branch serves when its starter reads its reply or report. */
export async function servesLine(tx: Tx, from: Message['from'], to: Message['to']) {
  if (typeof from !== 'number') return ''
  const { by, serves } = await tx.doc(Started, from as ConversationId)
  if (!serves || by !== to) return ''
  const asker = serves.from === 'remote' ? remoteLabel(serves.remote!) : `#${serves.from}`
  return `\n#${from} works on ${asker}'s message ${serves.message}. Once #${from} is concluded, your final answer to it goes to ${asker} instead.`
}

/** The browser's label for another project's primary agent. */
export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`

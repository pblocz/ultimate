import { shortTitle } from '@ultimate/lib/title.ts'
import type { ConversationSummary } from '@ultimate/shared/protocol.ts'
import type { Landing } from '@ultimate/ext/prompt/refs.ts'
import { git } from './git.ts'

/**
 * The landings in the clone from commit `from` to `to`, newest first: one row per branch, named by its title, else by
 * its newest commit's subject. A commit names its conversation by trailer, a lander merge in its subject; a
 * subagent's commit counts for the branch that owns it. A commit made outside Ultimate is a row of its own.
 */
export async function landings(
  cwd: string,
  from: string,
  to: string,
  conversations: ConversationSummary[],
): Promise<Landing[]> {
  const log = await git(
    cwd,
    'log',
    '--first-parent',
    '-n',
    '200',
    '--format=%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x1e',
    `${from}..${to}`,
  )
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const rows = new Map<string, Landing>()
  for (const record of log.split('\x1e')) {
    const [sha, subject, trailer] = record.trim().split('\0')
    if (!sha) continue
    let id = Number(trailer?.trim()) || Number(/ from #(\d+) into /.exec(subject)?.[1]) || undefined
    // An owned conversation (a worker, a designer) worked for its owner's branch.
    for (let owner = id && byId.get(id)?.parentConversationId; owner;) {
      id = owner
      owner = byId.get(owner)?.parentConversationId
    }
    const key = id ? `#${id}` : sha
    if (rows.has(key)) continue
    const title = id && byId.get(id)?.title
    rows.set(key, {
      ...(id ? { conversation: id } : {}),
      title: title ? shortTitle(title) : subject,
      sha,
    })
  }
  return [...rows.values()]
}

/** Conduct rules for coding-workflow conversations: the principles and shared-checkout advice that ordinary chats lack. */
import type { Context } from '@earendil-works/chord/context'
import { section } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Whether `id` is an ordinary chat or works for one: a `chat` label on it, its owner, or a fork's parent. */
async function inChat(host: ExtensionHost, id: ConversationId, ctx: Context) {
  for (let at: ConversationId | undefined = id; at !== undefined;) {
    if ((await host.harness().snapshot(host.metadata, at, ctx))?.label === 'chat') return true
    const record = await host.harness().commit((tx) => tx.conversation(at!), ctx)
    at = record?.owner?.conversationId ?? record?.parent?.conversationId
  }
  return false
}

const PRINCIPLES = `- Read what kind of request it is. A question, or "how could we…", asks you to explore: investigate, then come back with one proposal that includes what the person may not have thought of (a risk, a simpler path, a case it also touches), and wait for their go before changing anything. A clear instruction ("do this", "fix that"), a delegated task or a scheduled run is the go, unless it asks for an assessment first: do it, verify, and report, asking only about decisions that change behaviour or scope. When you need a decision from the person, ask it the way your instructions say.
- Understand before you change: read the relevant code, run it, look at it. Ground every claim in files, command output, tests, or screenshots.
- Keep it simple: question the need, reuse what exists, prefer platform features and installed dependencies, and write the least code that solves the actual problem. No speculative abstractions, compatibility shims, or fallbacks for situations that do not exist.
- Fail fast, iterate quickly, verify by trying: make a small change, run it, check the result in tests, the running app, or a screenshot, then take the next step.
- Never claim success you have not verified. When a check fails, say so and show the output. When you skipped something, say that.
- Taste matters. Code reads like the code around it; UI is clean, consistent, and quiet. Leave things better than you found them, within the scope you were asked for.
- Think about how it is experienced, not just whether it works. Before building or delegating anything a person sees, look at how the app presents similar things today (take screenshots, open older ones, read neighbouring renderers) and design the new thing to match: an outcome the user waits for gets a clear, distinct card, never raw text in a plain message. Connect what you learn: a pattern the user corrected once applies to every similar case, without being asked again.
- Be concise and direct. Surface the risks and tradeoffs that matter, and recommend one option instead of listing them all.`

/** Each conversation's answer is fixed: labels are set at creation and ownership never changes. */
export function conductSections(host: ExtensionHost) {
  const chats = new Map<ConversationId, boolean>()
  const ordinary = async (id: ConversationId, ctx: Context) => {
    if (!chats.has(id)) chats.set(id, await inChat(host, id, ctx))
    return chats.get(id)!
  }
  return [
    section('principles', async (input, ctx) =>
      (await ordinary(input.conversationId, ctx)) ? undefined : PRINCIPLES,
    ),
    section('shared_checkout', async (input, ctx) => {
      if (await ordinary(input.conversationId, ctx)) return undefined
      const record = await host.harness().commit((tx) => tx.conversation(input.conversationId), ctx)
      // Owned conversations (subagents) report to their owner, as the conversations section skips them.
      if (!record || record.owner) return undefined
      return 'Some other conversations may work in your checkout: check `git status` before broad changes, never revert or reformat changes you did not make, and coordinate through the user.'
    }),
  ]
}

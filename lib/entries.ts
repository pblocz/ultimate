import type { ConversationId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { int, lit, union } from '@earendil-works/pi-schema'

/** The shared image selector for message and branch tools. */
export const imagesParameter = union([lit('latest'), int({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for those of this turn (your current input, or a tool result such as a screenshot since; it fails when there are none), or an entry id for older ones.',
})

/** Pi inputs and harness-marked typed inputs count; user-role writes are context, not requests. */
export const isInput = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true

/** The images an entry carries in its user or tool-result messages: a pasted input, a screenshot, forwarded images. */
export function imagesOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? []).flatMap((message) =>
    (message.role === 'user' || message.role === 'toolResult') &&
    typeof message.content !== 'string'
      ? message.content.flatMap((block) =>
          block.type === 'image'
            ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }]
            : [],
        )
      : [],
  )
}

/**
 * `images: "latest"`: the newest entry with images in this turn, the conversation's newest input and the tool results
 * after it. Never an older turn's: an image-less request must not carry an unrelated screenshot from earlier.
 */
export async function latestImagesEntry(tx: Tx, conversationId: ConversationId) {
  const none = new Error(
    'images: "latest" found no images in this turn (your current input and the tool results since); pass an entry id to forward an older one',
  )
  let cursor: Parameters<Tx['scanEntries']>[2]
  do {
    const page = await tx.scanEntries({ conversationId }, 200, cursor)
    for (const entry of page.items) {
      if (imagesOf(entry).length) return entry
      if (isInput(entry)) throw none
    }
    cursor = page.next
  } while (cursor !== undefined)
  throw none
}

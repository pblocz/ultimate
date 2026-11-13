import { expect, it } from 'vitest'
import { onboarded } from '../../extensions/onboarding/onboarded.ts'
import { landing } from '../../extensions/sidebar/chats.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'

const chat = (id: number, inputAt?: number): ConversationSummary => ({
  id,
  label: 'chat',
  busy: false,
  ...(inputAt !== undefined && { inputAt }),
})

// Phase 3 replaces the @ultimate landing: with no selection, the page opens the latest ordinary chat, else the empty
// new-chat screen. A page load never creates or selects a primary agent or the internal root.
it('opens the latest ordinary conversation when none is chosen, once the shared state arrived', () => {
  const conversations = [
    { id: 1, busy: false },
    { id: 7, label: 'agent', title: '@ultimate', busy: false, inputAt: 900 },
    chat(9, 100),
    chat(12, 300),
    { ...chat(14, 800), parentConversationId: 12 },
  ]
  expect(landing(true, undefined, conversations)).toBe(12)
  expect(landing(false, undefined, conversations)).toBeUndefined()
  expect(landing(true, 9, conversations)).toBeUndefined()
})

it('stays on the empty new-chat screen without ordinary conversations', () => {
  expect(landing(true, undefined, [])).toBeUndefined()
  expect(
    landing(true, undefined, [
      { id: 1, busy: false },
      { id: 7, label: 'agent', busy: false },
    ]),
  ).toBeUndefined()
})

it("treats a new chapter's root with carried memories as onboarded", () => {
  expect(onboarded(undefined, { memories: { 'about-daniel': {} } })).toBe(true)
  expect(onboarded(undefined, { memories: {} })).toBe(false)
  expect(onboarded(42, null)).toBe(true)
})

import { defineWebExtension, provide } from '@/sdk'
import { OpenLatest, OrdinaryConversations, useChatIds } from './ordinary.tsx'
import { Unlisted } from './ui.tsx'

export default defineWebExtension({
  slots: { sidebar: [OrdinaryConversations], overlay: [OpenLatest] },
  // Other sidebar sections (the coding workflow's project tree) leave the ordinary conversations to this list.
  provides: [provide(Unlisted, useChatIds)],
})

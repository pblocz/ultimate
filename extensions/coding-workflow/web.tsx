/** The coding project tree, branch rows, and coding onboarding. */
import { defineWebExtension } from '@/sdk'
import {
  NoGit,
  onboardingCommands,
  onboardingEntries,
  onboardingProvides,
  StartComposer,
} from './onboarding.tsx'
import { Conversations, Seen } from './sidebar.tsx'

export default defineWebExtension({
  composer: StartComposer,
  entries: onboardingEntries,
  slots: {
    sidebar: [{ component: Conversations, order: 100 }],
    overlay: [Seen],
    'statusline.right': [{ component: NoGit, phone: true, order: -1 }],
  },
  provides: onboardingProvides,
  commands: onboardingCommands,
})

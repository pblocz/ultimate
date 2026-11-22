/**
 * The coding workflow in the browser: the project tree with @ultimate, its branches, roots and landings in the
 * sidebar, the title bar's @ultimate button, Talk to @ultimate, error reports for @ultimate to debug, and the coding
 * onboarding (Start here, the Git setup card, the walkthrough).
 */
import {
  api,
  defineWebExtension,
  ErrorReport,
  insertIntoComposer,
  provide,
  useUltimate,
} from '@/sdk'
import { StandingAction, talkToUltimate } from '@ultimate/ext/subagents/ui.tsx'
import {
  NoGit,
  onboardingCommands,
  onboardingEntries,
  onboardingProvides,
  StartComposer,
} from './onboarding.tsx'
import { Conversations, Seen } from './sidebar.tsx'
import { UltimateButton, UltimateWordmark } from './ultimate.tsx'

/** An error card's report goes into @ultimate's draft, unsent, beside whatever the user had typed there. */
function useErrorReport() {
  const { switchConversation, showSurface, focusComposer } = useUltimate()
  return {
    title: 'Debug with @ultimate',
    send: (report: string) =>
      void api
        .action(StandingAction, { name: 'ultimate' })
        .then((id) => {
          insertIntoComposer(id, report)
          showSurface('agent')
          switchConversation(id)
          requestAnimationFrame(focusComposer)
        })
        .catch((error: unknown) => console.error('Could not open @ultimate', error)),
  }
}

export default defineWebExtension({
  // Until onboarding has run, @ultimate's composer carries the card that starts it.
  composer: StartComposer,
  entries: onboardingEntries,
  slots: {
    // Below the ordinary conversations, which the sidebar extension lists first.
    sidebar: [{ component: Conversations, order: 100 }],
    // Phones only, where the sidebar with @ultimate's row is hidden; last in the title bar's left side.
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
    // Before onboarding's project setup link, as before the move.
    'statusline.right': [{ component: NoGit, phone: true, order: -1 }],
  },
  // Later in discovery order than agent's report into the selected conversation, so this one wins.
  provides: [provide(ErrorReport, useErrorReport), ...onboardingProvides],
  commands: [
    ...onboardingCommands,
    {
      id: 'subagents.ultimate',
      title: 'Talk to @ultimate',
      keys: 'mod+0',
      run: (context) => talkToUltimate(context),
    },
  ],
})

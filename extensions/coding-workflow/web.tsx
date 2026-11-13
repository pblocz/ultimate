/**
 * The coding workflow in the browser: the project tree with @ultimate, its branches, roots and landings in the
 * sidebar, the title bar's @ultimate button, Talk to @ultimate, and error reports for @ultimate to debug.
 */
import {
  api,
  defineWebExtension,
  ErrorReport,
  insertIntoComposer,
  provide,
  useUltimate,
} from '@/sdk'
import { StandingAction, talkToUltimate } from '../subagents/ui.tsx'
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
  slots: {
    // Below the ordinary conversations, which the sidebar extension lists first.
    sidebar: [{ component: Conversations, order: 100 }],
    // Phones only, where the sidebar with @ultimate's row is hidden; last in the title bar's left side.
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
    overlay: [Seen],
  },
  // Later in discovery order than agent's report into the selected conversation, so this one wins.
  provides: [provide(ErrorReport, useErrorReport)],
  commands: [
    {
      id: 'subagents.ultimate',
      title: 'Talk to @ultimate',
      keys: 'mod+0',
      run: (context) => talkToUltimate(context),
    },
  ],
})

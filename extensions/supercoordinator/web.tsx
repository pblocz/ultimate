import {
  api,
  defineWebExtension,
  ErrorReport,
  insertIntoComposer,
  provide,
  useUltimate,
} from '@/sdk'
import { OpenCoordinatorAction, talkToCoordinator } from '@ultimate/ext/subagents/ui.tsx'
import { UltimateButton, UltimateWordmark } from './shortcut.tsx'

/** Put a report in the coordinator's draft, without sending it. */
function useErrorReport() {
  const { switchConversation, showSurface, focusComposer } = useUltimate()
  return {
    title: 'Debug with @ultimate',
    send: (report: string) =>
      void api
        .action(OpenCoordinatorAction, null)
        .then((id) => {
          insertIntoComposer(id, report)
          showSurface('agent')
          switchConversation(id)
          requestAnimationFrame(focusComposer)
        })
        .catch((error: unknown) => console.error('Could not open the coordinator', error)),
  }
}

export default defineWebExtension({
  slots: {
    'titlebar.brand': [UltimateWordmark],
    'titlebar.left': [{ component: UltimateButton, order: 100 }],
  },
  provides: [provide(ErrorReport, useErrorReport)],
  commands: [
    { id: 'subagents.ultimate', title: 'Talk to @ultimate', keys: 'mod+0', run: talkToCoordinator },
  ],
})

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { SubagentsApi, SubagentsWorkflow } from '@ultimate/ext/subagents/api.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { subscribeToEscalations } from './escalations.ts'
import { notice } from './notice.ts'
import { subscribeToBranchQuestions } from './questions.ts'

const name = 'ultimate'
const Binding = defineDoc<{ id?: ConversationId }>({
  kind: 'supercoordinator.binding',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Binding]

export default function supercoordinator(host: ExtensionHost) {
  host.implement(SubagentsWorkflow, {
    coordinatorName: () => name,
    onDemand: (resident) => resident === name,
    restoreBinding: async (tx, resident) =>
      resident === name ? (await tx.doc(Binding, ROOT_CONVERSATION_ID)).id : undefined,
    saveBinding: async (tx, resident, id) => {
      if (resident === name) (await tx.doc(Binding, ROOT_CONVERSATION_ID)).id = id
    },
  })
  let open = false
  host.onOpen(async () => {
    open = true
    await host.need(SubagentsApi).refreshStanding(BACKGROUND_CONTEXT)
  })
  host.onRelease(async () => {
    open = false
  })
  // A live unload removes the provider before it calls this cleanup. A normal close runs onRelease first.
  host.onClose(async () => {
    if (open) await host.need(SubagentsApi).refreshStanding(BACKGROUND_CONTEXT)
  })
  subscribeToBranchQuestions(host)
  return defineExtension({
    name: 'supercoordinator',
    tasks: [notice(host), subscribeToEscalations(host)],
  })
}

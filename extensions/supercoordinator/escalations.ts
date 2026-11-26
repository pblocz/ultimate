import { ROOT_CONVERSATION_ID, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { MessagesApi } from '@ultimate/ext/messages/api.ts'
import { SubagentsApi } from '@ultimate/ext/subagents/api.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { escalationNotice } from '@ultimate/shared/automation-escalation.ts'
import type { AutomationEscalation } from '@ultimate/shared/automation-escalation.ts'
import { defineEvent } from '@ultimate/shared/events.ts'

export function subscribeToEscalations(host: ExtensionHost) {
  const subagents = host.need(SubagentsApi)
  const messages = host.need(MessagesApi)
  const deliver = defineTask<AutomationEscalation & { event: number }, { phase: 'deliver' }, null>({
    name: 'supercoordinator.automation-alert',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const saved = await runtime.memo('recipient', ctx)
        const role = await subagents.coordinator(ctx)
        if (role) {
          const id =
            typeof saved === 'number'
              ? (saved as ConversationId)
              : (role.id ?? (await subagents.standing(role.name, ctx)))
          if (saved === undefined) await runtime.memo('recipient', id, ctx)
          const target = await runtime.conversation(id, ctx)
          // A pending alert must not wake a retired holder or move after admission.
          if (target && (await subagents.coordinator(ctx))?.id === id)
            await messages.notify(target, escalationNotice(task.input, task.input.event), ctx)
        }
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  // No import from the optional Automations extension.
  const escalated = defineEvent<AutomationEscalation>('automations.escalated')
  host.react(
    'automation-alerts',
    [escalated],
    async (tx, event) => {
      const input = { ...event.data, event: event.id }
      await tx.createTask(deliver, input, {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      })
    },
    { from: 'now' },
  )
  return deliver
}

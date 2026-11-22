/** The existing durable notification task, independent of script preparation and processes. */
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { AutomationsWorkflow } from './api.ts'
import type { Automation, Subscriber } from './types.ts'

export type Delivery = {
  sub: Automation
  event: number | string
  kind: 'writing' | 'fired' | 'failed' | 'escalated'
  text: string
  targets: Subscriber[]
}
export function notifications(
  host: ExtensionHost,
  /** A script's content for its watcher, or undefined when the automation stopped and the watcher gets nothing. */
  scriptContent: (
    sub: Automation,
    kind: 'writing' | 'failed',
    text: string,
  ) => Promise<string | undefined>,
) {
  const Deliver = defineTask<Delivery, { phase: 'deliver' }, null>({
    name: 'ultimate.automation-delivery',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { sub, event, kind, text, targets } = task.input
        const content =
          kind === 'writing' || kind === 'failed'
            ? await scriptContent(sub, kind, text)
            : `Automation ${sub.id} "${sub.name}" ${kind}: ${text}`
        if (content === undefined) {
          await runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
            ctx,
          )
          return
        }
        let coordinator: ConversationId | undefined
        if (kind === 'escalated') {
          try {
            coordinator = await host
              .want(AutomationsWorkflow)
              ?.escalate(
                (sub.script?.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId,
                { id: sub.id, event, text: content },
                ctx,
              )
          } catch (error) {
            // Phase 2: an extra coordinator alert must not prevent ordinary subscriber delivery.
            console.warn(`Automation ${sub.id}: coordinator alert failed`, error)
          }
        }
        for (const target of targets) {
          const id = (
            typeof target === 'string'
              ? await host.need(SubagentsApi).standing(target.slice(1), ctx)
              : target
          ) as ConversationId
          if (kind === 'escalated' && id === coordinator) continue
          // Preserve the existing rule for legacy lander subscribers, which accept no input.
          if ((await runtime.snapshot(host.metadata, id, ctx))?.label === 'lander') continue
          const conversation = await runtime.conversation(id, ctx)
          if (!conversation) throw new Error(`Automation ${sub.id}: conversation #${id} is missing`)
          await host.need(MessagesApi).notify(
            conversation,
            {
              text: content,
              requestId: `automations:${sub.id}:${event}:${target}`,
              entry: {
                kind: `automations.${kind}`,
                data: { id: sub.id, name: sub.name, text },
              },
            },
            ctx,
          )
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
  async function deliver(
    tx: Tx,
    sub: Automation,
    event: number | string,
    kind: Delivery['kind'],
    text: string,
  ) {
    await tx.createTask(
      Deliver,
      {
        sub: JSON.parse(JSON.stringify(sub)) as Automation,
        event,
        kind,
        text,
        targets:
          kind === 'writing' || kind === 'failed'
            ? [sub.script!.conversationId]
            : [...sub.subscribers],
      },
      {
        ownership: { kind: 'conversation' },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      },
    )
  }
  return { Deliver, deliver }
}

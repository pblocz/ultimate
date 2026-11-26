/** Passive branch question notes. Keep the existing task and request IDs for pending notices. */
import { defineTask } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { SubagentsApi } from '@ultimate/ext/subagents/api.ts'

export type BranchNotice = {
  to: number
  kind: 'board.asked' | 'board.answered'
  data: {
    message: number
    from: number
    call?: string
    summary?: string
    dismissed?: boolean
    /** The coordinator settled it for the user. */
    via?: { conversation: number; entry?: number }
  }
  content: string
}

export const notice = (host: ExtensionHost) =>
  defineTask<BranchNotice, { phase: 'submit' }, null>({
    name: 'board.notice',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { to, kind, data, content } = task.input
        const target = await host.harness().conversation(to as ConversationId, ctx)
        await runtime.commit(async (tx) => {
          if (target && (await host.need(SubagentsApi).coordinator(ctx, tx))?.id === to)
            await target.submit(tx, {
              type: 'write',
              requestId: `${kind}:${data.message}`,
              entry: { kind, data, model: [{ role: 'user', content, timestamp: Date.now() }] },
            })
          return { status: 'terminal', outcome: { status: 'completed', result: null } } as const
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

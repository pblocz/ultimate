import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, GenerationResult, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { actingAs } from '@ultimate/lib/acting-as.ts'
import { AutomationsWorkflow } from '@ultimate/ext/automations/api.ts'
import { LineageApi } from '@ultimate/ext/lineage/api.ts'
import { MessagesApi, MessagesWorkflow, Started } from '@ultimate/ext/messages/api.ts'
import { OnboardingWorkflow } from '@ultimate/ext/onboarding/api.ts'
import { SubagentsApi } from '@ultimate/ext/subagents/api.ts'
import { Branches, WorkspacesApi } from '@ultimate/ext/workspaces/api.ts'
import { branchTool } from './branch.ts'
import { conductSections } from './conduct.ts'
import { servesLine, starterOf } from './addresses.ts'
import { onboardingWorkflow } from './onboarding.ts'
import { posted } from './posted.ts'
import { reported, route, working } from './route.ts'

/** The user's actual input that started the current run, retained as the settlement source. */
async function runInput(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const run = (await host.harness().snapshot(LiveDoc, id, ctx))?.run
  let found: number | undefined
  for (const submission of run?.inputs ?? []) {
    const record = await (await host.harness().submission(submission, ctx))?.status(ctx)
    if (record?.type !== 'input' || record.entry === undefined) continue
    const entry = await host.harness().commit((tx) => tx.entry(record.entry!), ctx)
    if (entry?.kind === 'pi.user' || entry?.kind === 'voice.utterance') found = entry.id
  }
  return found
}

export default function codingWorkflow(host: ExtensionHost) {
  host.need(MessagesApi)
  host.need(SubagentsApi)
  const coordinatorOf = (ctx: Context, tx?: Tx) => host.need(SubagentsApi).coordinator(ctx, tx)
  host.need(LineageApi)
  host.need(WorkspacesApi)
  host.implement(OnboardingWorkflow, onboardingWorkflow(host))
  host.implement(Branches, {
    starter: (id, ctx) => starterOf(host, id, ctx),
    working: (tx, id) => working(tx, id),
  })
  host.implement(AutomationsWorkflow, {
    escalate: async (from, input, ctx) => {
      const coordinator = await coordinatorOf(ctx)
      if (!coordinator) return undefined
      const to = coordinator.id === undefined ? `@${coordinator.name}` : `#${coordinator.id}`
      const requestId = `automations:${input.id}:${input.event}:ultimate`
      await host
        .need(MessagesApi)
        .send(from, { to, text: input.text, reply: false }, requestId, ctx)
      return coordinator.id ?? (await coordinatorOf(ctx))?.id
    },
    note: async (input) => {
      await host
        .need(LineageApi)
        .leaveNote(
          input.to,
          `Side chat #${input.from} ${input.action === 'create' ? 'created' : 'subscribed to'} automation ${input.automation}.`,
          { from: input.from, requestId: input.requestId },
        )
    },
  })
  host.implement(MessagesWorkflow, {
    primary: async (tx) => (await coordinatorOf(BACKGROUND_CONTEXT, tx))?.id,
    starter: (id, ctx) => starterOf(host, id, ctx),
    replyAwaits: async (tx, from, to) => (await tx.doc(Started, from as ConversationId)).by === to,
    authorizeUserMessage: async (from, ctx) => {
      const coordinator = await coordinatorOf(ctx)
      const parent = from === 'user' ? undefined : await host.need(MessagesApi).parent(from, ctx)
      const starter = parent ?? (await starterOf(host, from, ctx))
      if (from !== coordinator?.id && !(parent === undefined && starter !== undefined)) {
        const allowed = coordinator ? `@${coordinator.name} and branches` : 'branches'
        throw new Error(
          `Only ${allowed} message the user; send this to the conversation that started you.`,
        )
      }
    },
    validateRecipient: async (tx, id) => {
      const roots = host.doc('lineage.roots')
      const tally = host.doc('lineage.tally')
      if (roots && tally) {
        const index = (await tx.doc(roots, ROOT_CONVERSATION_ID)) as { roots?: number[] }
        const state = (await tx.doc(tally, id)) as { since?: number; converting?: unknown }
        if (index.roots?.includes(id) && (state.since !== undefined || state.converting))
          throw new Error(`#${id} is a tally and takes no inputs; use note instead`)
      }
    },
    servesLine,
    questionContext: async (tx, id) => {
      const all = (await coordinatorOf(BACKGROUND_CONTEXT, tx))?.id === id
      return {
        all,
        ...(all
          ? {
              settleHint:
                "When the user decides one in your chat, settle it with ultimate.action('messages', 'settle', { messageId, text }).",
            }
          : {}),
      }
    },
    posted: (...args) => posted(host, ...args),
    settle: async (from, input, ctx) => {
      const coordinator = await coordinatorOf(ctx)
      const primary = coordinator?.id
      if (
        from === undefined ||
        !coordinator ||
        primary === undefined ||
        (await actingAs(host, from, ctx)) !== primary
      )
        throw new Error(
          `Only ${coordinator ? `@${coordinator.name}` : 'the standing coordinator'} settles the user's questions`,
        )
      const entry = await runInput(host, from, ctx)
      const via = { conversation: from, ...(entry === undefined ? {} : { entry }) }
      const messages = host.need(MessagesApi)
      const fromLabel = `user (settled for them by @${coordinator.name}, from what they said in its chat)`
      return input.dismiss
        ? messages.dismiss(input.messageId, ctx, undefined, { via, reason: input.text, fromLabel })
        : messages.answer(input.messageId, input.text, ctx, undefined, { via, primary, fromLabel })
    },
    instructions: async (id, ctx) => {
      const agents = await host.need(SubagentsApi).residents(ctx)
      const coordinator = await coordinatorOf(ctx)
      const allowed = coordinator ? `@${coordinator.name} and branches` : 'Branches'
      const starter = await starterOf(host, id, ctx)
      const upward =
        starter === undefined
          ? ''
          : ` #${starter} started you: when you stop with nothing under way (no subagent, landing or reply pending), your final answer goes to it and wakes it; while work is under way it arrives as a note, and so do your one-way messages to it.`
      return `Use message to contact #id or @name. ${allowed} may message user. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply. A message to an agent whose message you still owe an answer becomes that answer and ends your run; use it only to attach images.${upward}\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
    },
    sideChatMessage: async (input) => {
      await host
        .need(LineageApi)
        .leaveNote(
          input.from,
          `Side chat #${input.conversation} messaged #${input.to} (reply comes here): ${input.text.split('\n')[0].slice(0, 160)}`,
          { from: input.conversation, requestId: input.requestId },
        )
    },
    awaitsReport: async (tx, id, read) => (await reported(host, tx, id, read)).branches.length > 0,
  })
  return defineExtension({
    name: 'coding-workflow',
    tasks: [route(host)],
    tools: [branchTool(host)],
    sections: [
      // Ordinary chats and the conversations that work for them keep the neutral prompt.
      ...conductSections(host),
      // Agents that can start coding branches get the coding workflow text; a fork keeps its source's tools.
      section('coding_workflow', (input) =>
        input.agent.tools.some((tool) => tool.name === 'branch')
          ? `For coding work, build, verify, and report. Put project-specific tools, panels, agents, and skills in ${input.env?.cwd ?? input.agent.cwd ?? host.projectRoot}/.ultimate/, and personal ones in ~/.ultimate/.`
          : undefined,
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, ctx) => {
          let by = (await api.snapshot(Started, api.conversationId, ctx))?.by
          const down = by === undefined && (await coordinatorOf(ctx))?.id === api.conversationId
          if (down) by = api.conversationId
          if (by === undefined) return undefined
          await host.harness().commit(async (tx) => {
            // Record one observer for each generation in the same transaction as the task.
            const started = await tx.doc(Started, api.conversationId)
            if (started.yielded !== undefined && started.yielded >= api.taskId) return
            started.yielded = api.taskId
            await tx.createTask(
              route(host),
              {
                generation: api.taskId as TaskId<GenerationResult>,
                inputs: [...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? [])],
                by,
                ...(down ? { down } : {}),
              },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
              },
            )
          }, ctx)
          return undefined
        },
      }),
    ],
  })
}

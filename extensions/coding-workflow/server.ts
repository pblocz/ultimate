import type { Context } from '@earendil-works/chord/context'
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, GenerationResult, TaskId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { AutomationsWorkflow } from '../automations/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { MessagesApi, MessagesWorkflow, Started } from '../messages/api.ts'
import { Standing, SubagentsApi, SubagentsWorkflow } from '../subagents/api.ts'
import { Branches, WorkspacesApi } from '../workspaces/api.ts'
import { branchTool } from './branch.ts'
import { servesLine, starterOf } from './addresses.ts'
import { notice } from './notice.ts'
import { posted } from './posted.ts'
import { projectsSection, remoteAction, remoteReplyAction, tell } from './remote.ts'
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
  host.need(LineageApi)
  host.need(WorkspacesApi)
  host.implement(SubagentsWorkflow, { onDemand: (name) => name === 'ultimate' })
  host.implement(Branches, {
    starter: (id, ctx) => starterOf(host, id, ctx),
    working: (tx, id) => working(tx, id),
  })
  host.implement(AutomationsWorkflow, {
    escalate: async (from, input, ctx) => {
      await host
        .need(MessagesApi)
        .send(
          from,
          { to: '@ultimate', text: input.text, reply: false },
          `automations:${input.id}:${input.event}:ultimate`,
          ctx,
        )
      return (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
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
    primary: async (tx) =>
      (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate as ConversationId | undefined,
    starter: (id, ctx) => starterOf(host, id, ctx),
    replyAwaits: async (tx, from, to) => (await tx.doc(Started, from as ConversationId)).by === to,
    authorizeUserMessage: async (from, ctx) => {
      const primary = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
      const parent = from === 'user' ? undefined : await host.need(MessagesApi).parent(from, ctx)
      const starter = parent ?? (await starterOf(host, from, ctx))
      if (from !== primary && !(parent === undefined && starter !== undefined))
        throw new Error(
          'Only @ultimate and branches message the user; send this to the conversation that started you.',
        )
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
      const all = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === id
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
      const primary = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
      if (
        from === undefined ||
        primary === undefined ||
        (await actingAs(host, from, ctx)) !== primary
      )
        throw new Error("Only @ultimate settles the user's questions")
      const entry = await runInput(host, from, ctx)
      const via = { conversation: from, ...(entry === undefined ? {} : { entry }) }
      const messages = host.need(MessagesApi)
      const fromLabel = 'user (settled for them by @ultimate, from what they said in its chat)'
      return input.dismiss
        ? messages.dismiss(input.messageId, ctx, undefined, { via, reason: input.text, fromLabel })
        : messages.answer(input.messageId, input.text, ctx, undefined, { via, primary, fromLabel })
    },
    tell: (...args) => tell(host, ...args),
    remote: (input) => remoteAction(input, host),
    remoteReply: (input) => remoteReplyAction(input, host),
    projects: () => projectsSection(host),
    instructions: async (id, ctx) => {
      const agents = await host.need(SubagentsApi).residents(ctx)
      const starter = await starterOf(host, id, ctx)
      const upward =
        starter === undefined
          ? ''
          : ` #${starter} started you: when you stop with nothing under way (no subagent, landing or reply pending), your final answer goes to it and wakes it; while work is under way it arrives as a note, and so do your one-way messages to it.`
      return `Use message to contact #id or @name. @ultimate and branches may message user. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply. A message to an agent whose message you still owe an answer becomes that answer and ends your run; use it only to attach images.${upward}\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
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
    tasks: [route(host), notice(host)],
    tools: [branchTool(host)],
    sections: [
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
          const down =
            by === undefined &&
            (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate ===
              api.conversationId
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

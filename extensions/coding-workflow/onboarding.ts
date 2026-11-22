/**
 * The coding onboarding: @ultimate's onboarding start and walkthrough, help with the project and Git cards, and Git
 * setup. Onboarding's `start`, `walkthrough`, `help` and Git card call it through `onboarding.workflow`; moved from
 * onboarding unchanged, with its state and entry kinds.
 */
import { basename } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineEntry, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Conversation, ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { isolatable } from '@ultimate/lib/git.ts'
import { LineageApi } from '@ultimate/ext/lineage/api.ts'
import { Starts } from '@ultimate/ext/onboarding/api.ts'
import type { OnboardingWorkflowService } from '@ultimate/ext/onboarding/api.ts'
import { SubagentsApi } from '@ultimate/ext/subagents/api.ts'
import { WorkspacesApi } from '@ultimate/ext/workspaces/api.ts'

export const StartEntry = defineEntry<{
  root: number
  instructions?: string
  facts: {
    project: { name: string; path: string }
    firstRun: boolean
    projectUndecided: boolean
    gitReason?: string
    root: number
    rootEmpty: boolean
  }
}>('onboarding.start')
export const WalkthroughEntry = defineEntry<Record<string, never>>('walkthrough.start')

/** Whether the conversation answered anything after entry `from`: a reply that is no error or abort. */
async function answeredSince(tx: Tx, conversationId: ConversationId, from: EntryId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId, minEntryId: from, order: 'ascending' },
      100,
      cursor,
    )
    if (
      page.items.some((entry) => {
        const message = entry.model?.[0]
        return (
          message?.role === 'assistant' &&
          message.stopReason !== 'error' &&
          message.stopReason !== 'aborted'
        )
      })
    )
      return true
    cursor = page.next
  } while (cursor)
  return false
}

/** The walkthrough's model fact: @ultimate's model and context window, so beat 4 can recommend 1M+. */
async function modelLine(host: ExtensionHost, conversation: Conversation) {
  const ref = (await conversation.agent(context)).model
  const model = (await host.models()).find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref?.modelId,
  )
  return model
    ? `Model: ${model.provider}/${model.id}, context window ${model.contextWindow} tokens`
    : 'Model: unknown'
}

export function onboardingWorkflow(host: ExtensionHost): OnboardingWorkflowService {
  return {
    help: async (card) => {
      const id = await host.need(SubagentsApi).standing('ultimate', context)
      const conversation = (await host.harness().conversation(id, context))!
      await conversation.submit(
        {
          type: 'input',
          content:
            card === 'project'
              ? "Help me decide whether to use this project's setup."
              : 'Help me set up git for this folder.',
          whenBusy: 'followUp',
        },
        context,
      )
      return { id }
    },
    start: async (input, conversationId) => {
      const lineage = host.need(LineageApi)
      const root =
        input.root ??
        (conversationId === undefined
          ? undefined
          : await lineage.rootOf(conversationId, context)) ??
        1
      const harness = host.harness()
      const requestId = `onboarding:${root}`
      const existing = (await harness.snapshot(Starts, ROOT_CONVERSATION_ID, context))?.roots[
        String(root)
      ]
      if (existing !== undefined) {
        // A start whose run failed before answering (no model, an expired login, a provider error) never began. While
        // @ultimate's newest run failed that way and nothing since the start was answered (inputs typed meanwhile may
        // have failed too), continue it. Checked and admitted in one commit, so a second call finds it busy (#552022: a
        // start without a model was a dead end).
        const conversation = (await harness.conversation(existing as ConversationId, context))!
        await harness.commit(async (tx) => {
          const sent = await tx.submissionByRequest(conversation.id, requestId)
          const { run, runFailure } = await tx.doc(LiveDoc, conversation.id)
          if (
            sent?.status !== 'unanswered' ||
            sent.entry === undefined ||
            run !== undefined ||
            !['no_model', 'model_error'].includes(runFailure?.reason ?? '') ||
            (await answeredSince(tx, conversation.id, sent.entry))
          )
            return
          await conversation.submit(tx, { type: 'continue' })
        }, context)
        return { id: existing }
      }
      if ((await lineage.rootOf(root, context)) !== root) throw new Error('Expected a project root')
      const id = await host.need(SubagentsApi).standing('ultimate', context)
      const project = await host.projectSetup()
      const checkout = await isolatable(host.projectRoot)
      const facts = {
        project: { name: basename(host.projectRoot), path: host.projectRoot },
        firstRun: input.firstRun,
        projectUndecided: project.config && project.decision === null,
        ...('reason' in checkout ? { gitReason: checkout.reason } : {}),
        root,
        rootEmpty: await harness.commit(
          async (tx) =>
            !(await tx.scanEntries({ conversationId: root as ConversationId }, 1)).items.length,
          context,
        ),
      }
      const instructions = input.instructions
      const conversation = (await harness.conversation(id, context))!
      await conversation.submit(
        {
          type: 'input',
          content: [
            'Onboarding started.',
            await modelLine(host, conversation),
            `Project: ${facts.project.name}`,
            `Path: ${facts.project.path}`,
            `First run: ${facts.firstRun}`,
            `Project setup undecided: ${facts.projectUndecided}`,
            `Git isolation: ${facts.gitReason ?? 'ready'}`,
            `Root: ${root}; empty: ${facts.rootEmpty}`,
            ...(instructions === undefined ? [] : [`User instructions:\n${instructions}`]),
          ].join('\n'),
          entry: {
            kind: StartEntry.kind,
            data: { root, ...(instructions === undefined ? {} : { instructions }), facts },
          },
          requestId,
          whenBusy: 'followUp',
        },
        context,
      )
      await harness.commit(async (tx) => {
        ;(await tx.doc(Starts, ROOT_CONVERSATION_ID)).roots[String(root)] = id
      }, context)
      return { id }
    },
    walkthrough: async () => {
      const id = await host.need(SubagentsApi).standing('ultimate', context)
      const conversation = (await host.harness().conversation(id, context))!
      await conversation.submit(
        {
          type: 'input',
          content: `Walkthrough started: run how-ultimate-works, without project setup.\n${await modelLine(host, conversation)}`,
          entry: { kind: WalkthroughEntry.kind, data: {} },
          whenBusy: 'followUp',
        },
        context,
      )
      return { id }
    },
    gitReason: async () => {
      const checkout = await isolatable(host.projectRoot)
      return 'reason' in checkout ? checkout.reason : undefined
    },
    setupGit: () => host.need(WorkspacesApi).setupGit(),
  }
}

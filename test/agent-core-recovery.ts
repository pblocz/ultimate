/** Test scenarios only. Work, receipts, and history remain in the native SQLite store. */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { TaskId } from '@earendil-works/pi-durable'
import type { Automation } from '../extensions/automations/types.ts'
import { context } from '../server/harness.ts'
import type { agentCoreFixture } from './agent-core-fixture.ts'
import { until } from './until.ts'

type Fixture = Awaited<ReturnType<typeof agentCoreFixture>>
export type PendingAgentCore = {
  parent: number
  recipient: number
  child: number
  automation: string
  scheduler: number
}
const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
        .join('')

export function recoveryModel(pending: boolean): FauxResponseFactory {
  return (request, options) => {
    const user = textOf(request.messages.findLast((message) => message.role === 'user')?.content)
    // Pi adds a system state message after a tool result; react to the last model input.
    if (request.messages.findLast((message) => message.role !== 'system')?.role === 'toolResult')
      return fauxAssistantMessage('Pending work admitted')
    if (user === 'START_PENDING_CHILD')
      return fauxAssistantMessage(
        [
          fauxToolCall('subagent', {
            action: 'start',
            agent: 'neutral',
            task: 'PENDING_CHILD',
            background: true,
          }),
        ],
        { stopReason: 'toolUse' },
      )
    const recipient = /^START_PENDING_MESSAGE #(\d+)$/.exec(user)?.[1]
    if (recipient)
      return fauxAssistantMessage(
        [fauxToolCall('message', { to: `#${recipient}`, text: 'PENDING_QUESTION', reply: true })],
        { stopReason: 'toolUse' },
      )
    if (
      user === 'PENDING_CHILD' ||
      (user.startsWith('Message from #') && user.includes('PENDING_QUESTION'))
    ) {
      if (pending)
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        )
      return fauxAssistantMessage(
        user === 'PENDING_CHILD' ? 'CHILD_RECOVERED' : 'MESSAGE_RECOVERED',
      )
    }
    if (user === 'SCHEDULE_RECOVERY') return fauxAssistantMessage('SCHEDULE_RECOVERED')
    const received = request.messages
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content))
      .filter((text) => text.includes('CHILD_RECOVERED') || text.includes('MESSAGE_RECOVERED'))
    return fauxAssistantMessage(`Observed: ${received.length ? received.join('\n') : user}`)
  }
}
async function answered(f: Fixture, id: number, text: string) {
  const receipt = await f.channel.conversations.submit(id, { text, requestId: text })
  await until(
    async () =>
      (await f.channel.conversations.submission(id, receipt.submissionId)).status === 'answered',
  )
}
const invoke = (
  f: Fixture,
  action: string,
  args: { [key: string]: string | number[] },
  caller?: number,
) => f.extensions.invoke('automations', action, args, new AbortController().signal, caller)
async function automation(f: Fixture, id: string) {
  return ((await invoke(f, 'list', {})) as Automation[]).find((record) => record.id === id)!
}
export async function pendingAgentCore(f: Fixture): Promise<PendingAgentCore> {
  const parent = await f.channel.conversations.create({ title: 'Recovery parent' })
  const recipient = await f.channel.conversations.create({ title: 'Recovery recipient' })
  await answered(f, parent.id, 'START_PENDING_CHILD')
  let child: number | undefined
  await until(async () => {
    child = (await f.channel.conversations.list()).find(
      (conversation) => conversation.parentConversationId === parent.id,
    )?.id
    return child !== undefined && (await f.channel.conversations.get(child)).summary.busy
  })
  await answered(f, parent.id, `START_PENDING_MESSAGE #${recipient.id}`)
  await until(async () => (await f.channel.conversations.get(recipient.id)).summary.busy)
  const scheduled = (await invoke(
    f,
    'create',
    {
      name: 'Pending ordinary schedule',
      schedule: 'every 1d',
      prompt: 'SCHEDULE_RECOVERY',
      subscribers: [parent.id],
    },
    parent.id,
  )) as Automation
  if (!scheduled.scheduler || child === undefined)
    throw new Error('The recovery scenario did not create its pending native work')
  return {
    parent: parent.id,
    recipient: recipient.id,
    child,
    automation: scheduled.id,
    scheduler: scheduled.scheduler,
  }
}
export async function recoveredAgentCore(f: Fixture, ids: PendingAgentCore) {
  const scheduler = await f.harness.getTask(ids.scheduler as TaskId, context)
  await until(async () => {
    const items = (
      await f.channel.conversations.history(ids.parent, { direction: 'older', limit: 100 })
    ).items
    return (
      items.some((entry) => entry.type === 'other' && entry.kind === 'subagents.report') &&
      items.some((entry) => entry.type === 'other' && entry.kind === 'board.reply')
    )
  })
  await invoke(f, 'run', { id: ids.automation }, ids.parent)
  await until(async () =>
    (await automation(f, ids.automation)).runs.some((run) => run.status === 'done'),
  )
  await until(async () =>
    (
      await f.channel.conversations.history(ids.parent, { direction: 'older', limit: 100 })
    ).items.some((entry) => entry.type === 'other' && entry.kind === 'automations.fired'),
  )
  await until(async () => {
    const entries = (
      await f.channel.conversations.history(ids.parent, { direction: 'older', limit: 100 })
    ).items
    const text = entries
      .flatMap((entry) =>
        'content' in entry
          ? entry.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      )
      .join('\n')
    return (
      text.includes('CHILD_RECOVERED') &&
      text.includes('MESSAGE_RECOVERED') &&
      !(await f.channel.conversations.get(ids.parent)).summary.busy
    )
  })
  const items = (
    await f.channel.conversations.history(ids.parent, { direction: 'older', limit: 100 })
  ).items
  const count = (kind: string) =>
    items.filter((entry) => entry.type === 'other' && entry.kind === kind).length
  const text = items
    .flatMap((entry) =>
      'content' in entry
        ? entry.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
  const record = await automation(f, ids.automation)
  return {
    childReports: count('subagents.report'),
    messageReplies: count('board.reply'),
    notifications: count('automations.fired'),
    childRecovered: text.includes('CHILD_RECOVERED'),
    messageRecovered: text.includes('MESSAGE_RECOVERED'),
    scheduleRuns: record.runs.length,
    scheduleAnswer: record.runs[0]?.answer,
    schedulerRecovered:
      scheduler?.kind === 'ultimate.automation-scheduler' && scheduler.state.status !== 'terminal',
    diagnostics: await f.extensions.info.diagnostics(),
    missing: f.extensions.catalogue().missing,
    cycles: f.extensions.catalogue().cycles,
  }
}

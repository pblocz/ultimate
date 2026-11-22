import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Agent,
  AgentChange,
  AgentState,
  ConversationId,
  Cursor,
  EntryId,
  SubmissionId,
  SubmissionRecord,
  TaskGraph,
  Tx,
} from '@earendil-works/pi-durable'
import {
  configure as configureAgent,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { ChannelError } from '../shared/channel-host.ts'
import type {
  ChannelHost,
  CompactRequest,
  ConversationConfiguration,
  ConversationDetails,
  ConversationId as ChannelConversationId,
  ConversationSummary,
  ConfigureConversationRequest,
  CreateConversationRequest,
  HistoryRequest,
  InputImage,
  InputSource,
  SubmissionReceipt,
  SubmissionState,
  SubmitRequest,
} from '../shared/channel-host.ts'
import { maxImageBytes, maxImages, imageMimeTypes } from '../shared/protocol.ts'
import { UserInputEvent } from '../shared/events.ts'
import type { Device } from '../shared/events.ts'
import { emit, EVENT_LOG_LABEL } from './events.ts'
import { hostDefault } from '../lib/agents.ts'
import { readFamilies } from '../lib/families-settings.ts'
import { refOf } from '../lib/families.ts'
import { Family, Profile } from '../shared/conversation-configuration.ts'
import { prepareDefinition, applyDefinition } from './conversation-configuration.ts'
import type { ConfigurationServices } from './conversation-configuration.ts'
import { expandSkillCommand, projectSkills } from './skills.ts'
import type { SkillOwner } from './skills.ts'
import { onCommit } from '../lib/commits.ts'
import { conversationIndex } from './project.ts'
import { shortTitle } from '../lib/title.ts'
import { Metadata } from './metadata.ts'
import {
  historyLimit,
  parseHistoryCursor,
  projectConversationOutput,
  projectHistoryScan,
} from './conversation-projection.ts'
import { listChannelModels } from './models.ts'
import { context as hostContext } from './harness.ts'
import type { OpenHost, PreparedHost } from './harness.ts'

const positive = (value: number) => Number.isSafeInteger(value) && value > 0
const safeReasons = new Set([
  'aborted',
  'faulted',
  'interrupted',
  'model_error',
  'no_model',
  'nothing_to_answer',
  'orphaned',
  'reset',
  'restart_limit',
  'stale',
  'turn_limit',
])

/** An input over a size or count limit: still `invalid_input` for a channel, a 413 for the web. */
export class InputLimitError extends ChannelError {
  constructor(message: string) {
    super('invalid_input', message)
    // The web answers it with 413; its name tells it apart in the web extension's copy of this module.
    this.name = 'InputLimitError'
  }
}

type ConversationHostOptions = {
  configurationServices?: () => ConfigurationServices
  /** The loaded extensions, whose enabled members supply skills to `/skill:` expansion; none by default. */
  extensions?: () => readonly SkillOwner[]
  onConversations?: (summaries: ConversationSummary[]) => void
  onTasks?: (tasks: TaskGraph) => void
  onRefreshError?: (error: unknown) => void
}

/** In-process channels can save a binding in the same transaction as a new conversation. */
export type LocalChannelHost = Omit<ChannelHost, 'conversations'> & {
  conversations: Omit<ChannelHost['conversations'], 'create'> & {
    create(
      input: CreateConversationRequest,
      bind?: (tx: Tx, id: ConversationId) => Promise<void>,
    ): Promise<{ id: ChannelConversationId }>
  }
}

export interface ConversationBackend {
  readonly channelHost: LocalChannelHost
  conversations(): ConversationSummary[]
  taskGraph(): TaskGraph
  refreshConversation(id: number): Promise<void>
  /** Permit mutations after core setup and harness resume. */
  openAdmission(): void
  /** Synchronously reject new operations before release or shutdown cleanup begins. */
  closeAdmission(): void
  /** Track a legacy web read so storage stays open until it settles. */
  read<T>(work: () => Promise<T>): Promise<T>
  /** The web's submit: its device fields go on the event as before, without a channel source. */
  submit(id: number, input: SubmitRequest, device?: Device): Promise<SubmissionReceipt>
  /** The web's compaction, answered with its native task ID. */
  compact(id: number, input: CompactRequest): Promise<number>
  close(): Promise<void>
}

export async function createConversationHost(
  host: PreparedHost,
  opened: OpenHost,
  options: ConversationHostOptions = {},
): Promise<ConversationBackend> {
  const { harness } = opened
  const projectIndex = conversationIndex(host.home)
  let summaries: ConversationSummary[] = []
  let currentTasks: TaskGraph | undefined
  let graphChanged = () => {}
  let graphTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let retiring = false
  let admissionOpen = false
  let activeCalls = 0
  let callDrain: (() => void) | undefined
  let closing: Promise<void> | undefined
  let refreshing = Promise.resolve()

  const busy = (id: number) =>
    Object.values(currentTasks?.tasks ?? {}).some(
      (task) => task.conversationId === id && !task.background,
    )

  async function summariesFor(records: Awaited<ReturnType<typeof conversationRecords>>) {
    const refreshed: Omit<ConversationSummary, 'busy'>[] = []
    for (const record of records) {
      const conversation = await harness.conversation(record.id, hostContext)
      if (!conversation) continue
      const agent = await conversation.agent(hostContext)
      const metadata = await harness.snapshot(Metadata, record.id, hostContext)
      if (metadata?.label === EVENT_LOG_LABEL) continue
      // Older subagents were titled with their full prompt; keep refreshed summaries bounded.
      const full = metadata?.title ?? metadata?.inputTitle
      const title = full && full.length > 200 ? shortTitle(full, 200) : full
      refreshed.push({
        id: record.id,
        ...(record.owner ? { parentConversationId: record.owner.conversationId } : {}),
        ...(!record.owner && record.parent ? { branchOf: record.parent } : {}),
        ...(record.owner ? { ownerTaskId: record.owner.taskId } : {}),
        ...(metadata?.label ? { label: metadata.label } : {}),
        ...(title ? { title } : {}),
        cwd: agent.cwd,
        ...(metadata?.inputAt === undefined ? {} : { inputAt: metadata.inputAt }),
        ...(metadata?.answerAt === undefined ? {} : { answerAt: metadata.answerAt }),
      })
    }
    return refreshed
  }

  async function conversationRecords(ids?: Set<ConversationId>) {
    return harness.commit(async (tx) => {
      if (ids)
        return (await Promise.all([...ids].map((id) => tx.conversation(id)))).filter(
          (record) => record !== undefined,
        )
      const scanned = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        scanned.push(...page.items)
        cursor = page.next
      } while (cursor !== undefined)
      return scanned
    }, hostContext)
  }

  function snapshotSummaries() {
    return summaries.map((summary) => ({ ...summary }))
  }

  function publishSummaries(next: ConversationSummary[]) {
    if (JSON.stringify(next) === JSON.stringify(summaries)) return
    summaries = next
    projectIndex.update(summaries)
    options.onConversations?.(snapshotSummaries())
  }

  async function refreshConversations(ids?: Set<ConversationId>) {
    const records = await conversationRecords(ids)
    const refreshed = await summariesFor(records)
    const next = ids ? [...summaries] : []
    for (const fresh of refreshed) {
      const summary = { ...fresh, busy: busy(fresh.id) }
      const index = next.findIndex((item) => item.id === summary.id)
      if (index < 0) next.push(summary)
      else next[index] = summary
    }
    publishSummaries(next)
  }

  let lastGraph = ''
  const graphObservation = await harness.observeTaskGraph(
    {
      advance: (call) => {
        if (call.kind !== 'value') return
        currentTasks = call.value
        graphChanged()
      },
      end: () => {},
    },
    hostContext,
  )
  currentTasks ??= graphObservation.value
  const tasks = () => currentTasks!
  lastGraph = JSON.stringify(tasks())
  graphChanged = () => {
    if (closed || graphTimer) return
    graphTimer = setTimeout(() => {
      graphTimer = undefined
      const graphJson = JSON.stringify(tasks())
      if (graphJson === lastGraph) return
      lastGraph = graphJson
      options.onTasks?.(tasks())
      publishSummaries(summaries.map((summary) => ({ ...summary, busy: busy(summary.id) })))
    }, 100)
  }

  const detachCommits = onCommit(harness, (publication) => {
    if (closed) return
    const ids = new Set<ConversationId>()
    for (const change of publication.changes) {
      if (change.type === 'conversation') ids.add(change.value.id)
      if (
        change.type === 'document' &&
        change.conversationId &&
        (change.record.kind === 'ultimate.metadata' ||
          (change.record.kind === 'pi.agent' &&
            (change.kind === 'retire' ||
              change.ops.some((op) => op[0] === 'r' || op[1][0] === 'cwd'))))
      )
        ids.add(change.conversationId)
    }
    if (!ids.size) return
    refreshing = refreshing
      .then(() => refreshConversations(ids))
      .catch((error: unknown) => {
        if (options.onRefreshError) options.onRefreshError(error)
        else console.error('Refreshing conversation summaries failed:', error)
      })
  })

  try {
    await refreshConversations()
    projectIndex.update(summaries)
  } catch (error) {
    detachCommits()
    graphObservation.detach()
    clearTimeout(graphTimer)
    await projectIndex.flush()
    throw error
  }

  const activeWatches = new Set<() => void>()
  const unavailable = () => new ChannelError('unavailable', 'Conversation service is unavailable')
  const ensureOpen = () => {
    if (closed || retiring) throw unavailable()
  }
  const ensureAdmitted = () => {
    ensureOpen()
    if (!admissionOpen) throw unavailable()
  }
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    activeCalls++
    try {
      return await work()
    } finally {
      activeCalls--
      if (activeCalls === 0) {
        callDrain?.()
        callDrain = undefined
      }
    }
  }
  const mutate = <T>(work: (admit: () => void) => Promise<T>): Promise<T> => {
    ensureAdmitted()
    return track(() => work(ensureAdmitted))
  }
  const openAdmission = () => {
    if (closed || retiring) throw unavailable()
    admissionOpen = true
  }
  const closeAdmission = () => {
    admissionOpen = false
    retiring = true
    for (const stop of activeWatches) stop()
  }
  const ensureId = (id: number): ConversationId => {
    if (!positive(id)) throw new ChannelError('invalid_input', 'Invalid conversation id')
    return id as ConversationId
  }
  const requireConversation = async (id: ConversationId) => {
    const conversation = await harness.conversation(id, hostContext)
    if (!conversation) throw new ChannelError('not_found', 'Unknown conversation')
    return conversation
  }
  async function operation<T>(name: string, work: () => Promise<T>): Promise<T> {
    ensureOpen()
    try {
      return await track(work)
    } catch (error) {
      if (error instanceof ChannelError) throw error
      console.error(`Conversation ${name} failed:`, error)
      throw new ChannelError('internal', 'Conversation operation failed')
    }
  }
  const mutation = <T>(name: string, work: (admit: () => void) => Promise<T>) =>
    operation(name, () => mutate(work))

  function configuration(
    agent: Pick<AgentState, 'model' | 'thinkingLevel'>,
  ): ConversationConfiguration {
    return {
      ...(agent.model && {
        model: { provider: agent.model.provider, modelId: agent.model.modelId },
      }),
      ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }),
    }
  }

  async function readConfiguration(
    id: ConversationId,
    agent: Pick<AgentState, 'model' | 'thinkingLevel'>,
  ) {
    const [profile, family] = await Promise.all([
      harness.snapshot(Profile, id, hostContext),
      harness.snapshot(Family, id, hostContext),
    ])
    return {
      ...configuration(agent),
      ...(profile?.definition && { definition: profile.definition }),
      ...(family?.name && { preset: family.name }),
    }
  }

  async function prepareChange(
    base: Agent,
    change: ConfigureConversationRequest,
    // On an existing conversation a persona change keeps its model selection; a new one starts from the default.
    existing = false,
  ) {
    if (!change || typeof change !== 'object' || Array.isArray(change))
      throw new ChannelError('invalid_input', 'Invalid configuration')
    if (
      change.preset !== undefined &&
      change.preset !== null &&
      (typeof change.preset !== 'string' || !change.preset.trim())
    )
      throw new ChannelError('invalid_input', 'Expected preset name')
    if (change.preset && change.model !== undefined)
      throw new ChannelError('invalid_input', 'Choose a preset or a direct model, not both')
    let model = change.model
    let thinking = change.thinkingLevel
    if (change.preset) {
      const { families } = await readFamilies(host.userHome, host.projectRoot)
      if (!Object.hasOwn(families, change.preset))
        throw new ChannelError('invalid_input', `Unknown model preset: ${change.preset}`)
      const spec = families[change.preset]
      const fallback = change.preset === 'default' ? await hostDefault(host) : undefined
      model = refOf(spec.model) ?? fallback?.model
      thinking ??= spec.thinking ?? fallback?.thinkingLevel
      if (!model) throw new ChannelError('invalid_input', 'Model preset has no available model')
    }
    if (model !== undefined) {
      if (!model || typeof model !== 'object' || Array.isArray(model))
        throw new ChannelError('invalid_input', 'Invalid model')
      const { provider, modelId } = model
      if (typeof provider !== 'string' || !provider.trim())
        throw new ChannelError('invalid_input', 'Expected model.provider')
      if (typeof modelId !== 'string' || !modelId.trim())
        throw new ChannelError('invalid_input', 'Expected model.modelId')
      if (
        !(await host.models()).some(
          (candidate) =>
            candidate.available && candidate.provider === provider && candidate.id === modelId,
        )
      )
        throw new ChannelError('invalid_input', 'Model is not available')
    }
    const profile =
      change.definition === undefined
        ? undefined
        : await prepareDefinition(
            host,
            base,
            change.definition,
            { model, thinking },
            existing && model === undefined && thinking === undefined,
          )
    let fields: AgentChange = { ...profile?.change, ...(model && { model }) }
    if (thinking !== undefined || model) {
      const ref = fields.model ?? base.model
      const found = ref && host.model(ref)
      if (!found) throw new ChannelError('invalid_input', 'No model to set a thinking level for')
      const level =
        thinking === undefined
          ? clampThinkingLevel(found, base.thinkingLevel)
          : getSupportedThinkingLevels(found).find((candidate) => candidate === thinking)
      if (!level)
        throw new ChannelError(
          'invalid_input',
          `${found.provider}/${found.id} does not support thinking level ${JSON.stringify(thinking)}`,
        )
      fields = { ...fields, thinkingLevel: level }
    }
    const family = change.preset !== undefined ? change.preset : model ? null : profile?.family
    const services = options.configurationServices?.() ?? {}
    if (profile?.isolate === 'worktree' && !services.isolation)
      throw new ChannelError('unavailable', 'Worktree isolation is not available')
    if (profile?.definition?.summaries === false && !services.summaries)
      throw new ChannelError('unavailable', 'Conversation summaries support is not available')
    return { fields, profile, family, services }
  }

  async function applyChange(
    tx: Tx,
    id: ConversationId,
    prepared: Awaited<ReturnType<typeof prepareChange>>,
    cwd: string,
  ) {
    if (prepared.profile) await applyDefinition(tx, id, prepared.profile)
    await configureAgent(tx, id, prepared.fields)
    if (prepared.family !== undefined) (await tx.doc(Family, id)).name = prepared.family
    if (prepared.profile && prepared.services.summaries)
      await prepared.services.summaries(tx, id, prepared.profile.definition?.summaries !== false)
    if (prepared.profile?.isolate === 'worktree')
      await prepared.services.isolation!.prepare(tx, id, {
        cwd,
        instructions:
          typeof prepared.fields.instructions === 'string' ? prepared.fields.instructions : '',
      })
  }

  function validateSource(value: InputSource | undefined): InputSource | undefined {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ChannelError('invalid_input', 'Invalid input source')
    if (typeof value.channel !== 'string' || !value.channel.trim())
      throw new ChannelError('invalid_input', 'Expected source channel')
    const optional = [
      'instanceId',
      'senderId',
      'chatId',
      'threadId',
      'messageId',
      'replyToMessageId',
      'device',
      'login',
      'address',
    ] as const
    for (const key of optional)
      if (value[key] !== undefined && typeof value[key] !== 'string')
        throw new ChannelError('invalid_input', `Invalid input source ${key}`)
    return {
      channel: value.channel,
      ...(value.instanceId !== undefined && { instanceId: value.instanceId }),
      ...(value.senderId !== undefined && { senderId: value.senderId }),
      ...(value.chatId !== undefined && { chatId: value.chatId }),
      ...(value.threadId !== undefined && { threadId: value.threadId }),
      ...(value.messageId !== undefined && { messageId: value.messageId }),
      ...(value.replyToMessageId !== undefined && { replyToMessageId: value.replyToMessageId }),
      ...(value.device !== undefined && { device: value.device }),
      ...(value.login !== undefined && { login: value.login }),
      ...(value.address !== undefined && { address: value.address }),
    }
  }

  function validateImages(value: InputImage[] | undefined): InputImage[] {
    const images = value === undefined ? [] : value
    if (!Array.isArray(images)) throw new ChannelError('invalid_input', 'Expected images array')
    if (images.length > maxImages) throw new InputLimitError(`At most ${maxImages} images`)
    return images.map((image) => {
      if (!image || typeof image !== 'object' || Array.isArray(image))
        throw new ChannelError('invalid_input', 'Invalid image')
      const { data, mimeType } = image
      if (
        typeof mimeType !== 'string' ||
        !imageMimeTypes.includes(mimeType) ||
        typeof data !== 'string' ||
        !data ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      )
        throw new ChannelError(
          'invalid_input',
          'Expected supported image MIME type and base64 data',
        )
      if (Buffer.byteLength(data, 'base64') > maxImageBytes)
        throw new InputLimitError('Image exceeds 2 MiB')
      if (Buffer.from(data, 'base64').toString('base64') !== data)
        throw new ChannelError('invalid_input', 'Invalid image base64 data')
      return { mimeType, data }
    })
  }

  async function readSummary(id: ConversationId) {
    await refreshing
    let summary = summaries.find((item) => item.id === id)
    if (!summary) {
      await refreshConversations(new Set([id]))
      summary = summaries.find((item) => item.id === id)
    }
    if (!summary) throw new ChannelError('not_found', 'Conversation not found')
    return { ...summary }
  }

  async function readOutput(id: ConversationId) {
    const conversation = await requireConversation(id)
    const [summary, agent, live, entries] = await Promise.all([
      readSummary(id),
      conversation.agent(hostContext),
      harness.snapshot(LiveDoc, id, hostContext),
      conversation.entries({}, 1, undefined, hostContext),
    ])
    const latestEntryId = entries.items[0]?.id
    return {
      ...projectConversationOutput(summary, agent, live ?? {}, latestEntryId),
      configuration: await readConfiguration(id, agent),
    }
  }

  function watch(
    id: number,
    signal?: AbortSignal,
  ): AsyncIterableIterator<Awaited<ReturnType<typeof readOutput>>> {
    ensureOpen()
    const conversationId = ensureId(id)
    let version = 0
    let wake: (() => void) | undefined
    let detach: (() => void) | undefined
    let stopped = false
    const changed = () => {
      version++
      wake?.()
      wake = undefined
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      signal?.removeEventListener('abort', stop)
      detach?.()
      activeWatches.delete(stop)
      changed()
    }
    async function* snapshots() {
      try {
        ensureOpen()
        if (stopped || signal?.aborted) return
        signal?.addEventListener('abort', stop, { once: true })
        const observation = harness.observeCommits({
          advance: (publication) => {
            if (
              publication.changes.some(
                (change) =>
                  (change.type === 'conversation' && change.value.id === conversationId) ||
                  (change.type === 'entry' && change.value.conversationId === conversationId) ||
                  (change.type === 'task' && change.value.conversationId === conversationId) ||
                  (change.type === 'submission' &&
                    change.value.conversationId === conversationId) ||
                  (change.type === 'document' && change.conversationId === conversationId),
              )
            )
              changed()
          },
          end: stop,
        })
        detach = () => observation.detach()
        activeWatches.add(stop)
        await track(async () => {
          await requireConversation(conversationId)
        })
        let previous: string | undefined
        for (;;) {
          if (stopped || signal?.aborted) break
          const observed = version
          const output = await track(() => readOutput(conversationId))
          if (stopped || signal?.aborted) break
          const encoded = JSON.stringify(output)
          if (encoded !== previous) {
            previous = encoded
            yield output
          }
          if (version === observed && !stopped && !signal?.aborted)
            await new Promise<void>((resolve) => {
              if (version !== observed || stopped || signal?.aborted) resolve()
              else wake = resolve
            })
        }
      } catch (error) {
        if (error instanceof ChannelError) throw error
        console.error('Conversation output watch failed:', error)
        throw new ChannelError('internal', 'Conversation watch failed')
      } finally {
        stop()
      }
    }
    const iterator = snapshots()
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => iterator.next(),
      // Wake a pending next() before queuing return(); the generator cannot leave its await otherwise.
      return: () => {
        stop()
        return iterator.return(undefined)
      },
    }
  }

  const submitInput = (id: number, input: SubmitRequest, device?: Device) =>
    mutation('submit', async (admit) => {
      const conversationId = ensureId(id)
      const conversation = await requireConversation(conversationId)
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new ChannelError('invalid_input', 'Invalid input')
      if (typeof input.text !== 'string') throw new ChannelError('invalid_input', 'Expected text')
      if (
        input.whenBusy !== undefined &&
        input.whenBusy !== 'steer' &&
        input.whenBusy !== 'followUp'
      )
        throw new ChannelError('invalid_input', 'Invalid whenBusy')
      if (
        input.requestId !== undefined &&
        (typeof input.requestId !== 'string' || !input.requestId.trim())
      )
        throw new ChannelError('invalid_input', 'Expected a non-empty request id')
      const source = validateSource(input.source)
      const images = validateImages(input.images)
      if (!input.text.trim() && !images.length)
        throw new ChannelError('invalid_input', 'Expected text or images')
      const expanded = input.text.startsWith('/skill:')
        ? expandSkillCommand(
            input.text,
            projectSkills(
              host,
              (await conversation.agent(hostContext)).cwd ?? host.projectRoot,
              options.extensions?.() ?? [],
            ).skills,
          )
        : input.text
      const content = images.length
        ? [
            ...(expanded.trim() ? [{ type: 'text' as const, text: expanded }] : []),
            ...images.map((image) => ({
              type: 'image' as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ]
        : expanded
      admit()
      const submission = await conversation.submit(
        {
          type: 'input',
          content,
          ...(input.whenBusy !== undefined && { whenBusy: input.whenBusy }),
          ...(input.requestId !== undefined && { requestId: input.requestId }),
        },
        hostContext,
      )
      const admitted = await submission.status(hostContext)
      await harness.commit(
        (tx) =>
          emit(tx, UserInputEvent, {
            conversation: conversationId,
            kind:
              admitted.status !== 'queued'
                ? 'prompt'
                : input.whenBusy === 'steer'
                  ? 'steer'
                  : 'follow-up',
            ...(admitted.entry === undefined
              ? { submission: submission.id }
              : { entry: admitted.entry }),
            length: input.text.length,
            ...(source && { source }),
            ...(device ?? {
              ...(source?.device && { device: source.device }),
              ...(source?.login && { login: source.login }),
              ...(source?.address && { address: source.address }),
            }),
          }),
        hostContext,
      )
      return { conversationId, submissionId: submission.id }
    })

  const compactTask = (id: number, input: CompactRequest) =>
    mutation('compact', async (admit) => {
      const conversationId = ensureId(id)
      const conversation = await requireConversation(conversationId)
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new ChannelError('invalid_input', 'Invalid compact request')
      if (input.instructions !== undefined && typeof input.instructions !== 'string')
        throw new ChannelError('invalid_input', 'Invalid instructions')
      admit()
      return Number(await conversation.compact(input.instructions, hostContext))
    })

  const channelHost: LocalChannelHost = {
    conversations: {
      list: () => operation('list', async () => snapshotSummaries()),
      create: (
        input: CreateConversationRequest,
        bind?: (tx: Tx, id: ConversationId) => Promise<void>,
      ) =>
        mutation('create', async (admit) => {
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new ChannelError('invalid_input', 'Invalid create request')
          if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim()))
            throw new ChannelError('invalid_input', 'Expected title')
          if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim()))
            throw new ChannelError('invalid_input', 'Expected cwd')
          const cwd = input.cwd ?? host.projectRoot
          const root = await requireConversation(ROOT_CONVERSATION_ID)
          const base = { ...(await root.agent(hostContext)), ...(await hostDefault(host)), cwd }
          const prepared = await prepareChange(base, input)
          admit()
          const id = await harness.commit(async (tx) => {
            const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
            await configureAgent(tx, created.id, {
              cwd,
              model: base.model,
              thinkingLevel: base.thinkingLevel,
            })
            await applyChange(tx, created.id, prepared, cwd)
            Object.assign(await tx.doc(Metadata, created.id), {
              label: 'chat',
              ...(input.title && { title: input.title }),
            })
            await bind?.(tx, created.id)
            return created.id
          }, hostContext)
          await refreshConversations(new Set([id]))
          return { id }
        }),
      get: (id: ChannelConversationId) =>
        operation('get', async () => {
          const conversationId = ensureId(id)
          const conversation = await requireConversation(conversationId)
          const [summary, agent] = await Promise.all([
            readSummary(conversationId),
            conversation.agent(hostContext),
          ])
          return {
            summary,
            configuration: await readConfiguration(conversationId, agent),
          } satisfies ConversationDetails
        }),
      configure: (id, change) =>
        mutation('configure', async (admit) => {
          const conversationId = ensureId(id)
          const conversation = await requireConversation(conversationId)
          const current = await conversation.agent(hostContext)
          // Tool selection starts from the runtime base, not the previous profile's reduced inventory.
          const root = await requireConversation(ROOT_CONVERSATION_ID)
          const base = {
            ...(await root.agent(hostContext)),
            model: current.model,
            thinkingLevel: current.thinkingLevel,
          }
          const prepared = await prepareChange(base, change, true)
          if (
            prepared.profile &&
            (await prepared.services.isolation?.get(conversationId, hostContext))
          )
            throw new ChannelError('conflict', 'Change an isolated profile in a new conversation')
          admit()
          await harness.commit(async (tx) => {
            if (prepared.profile) {
              if ((await tx.doc(Metadata, conversationId)).label !== 'chat')
                throw new ChannelError(
                  'conflict',
                  'Profile selection requires an ordinary conversation',
                )
              if ((await tx.doc(LiveDoc, conversationId)).run)
                throw new ChannelError(
                  'conflict',
                  'Wait for the current turn before changing its profile',
                )
            }
            await applyChange(tx, conversationId, prepared, current.cwd ?? host.projectRoot)
          }, hostContext)
          return readConfiguration(conversationId, await conversation.agent(hostContext))
        }),
      submit: (id, input: SubmitRequest) => submitInput(id, input),
      submission: (id, submissionId) =>
        operation('submission', async () => {
          const conversationId = ensureId(id)
          if (!positive(submissionId))
            throw new ChannelError('invalid_input', 'Invalid submission id')
          await requireConversation(conversationId)
          const submission = await harness.submission(submissionId as SubmissionId, hostContext)
          if (!submission) throw new ChannelError('not_found', 'Submission not found')
          const record = await submission.status(hostContext)
          if (record.conversationId !== conversationId || record.type !== 'input')
            throw new ChannelError('not_found', 'Submission not found')
          return projectSubmissionState(record)
        }),
      cancelQueuedInput: (id, submissionId) =>
        mutation('cancel queued input', async (admit) => {
          const conversationId = ensureId(id)
          if (!positive(submissionId))
            throw new ChannelError('invalid_input', 'Invalid submission id')
          await requireConversation(conversationId)
          const submission = await harness.submission(submissionId as SubmissionId, hostContext)
          if (!submission) throw new ChannelError('not_found', 'Queued input not found')
          const record = await submission.status(hostContext)
          if (record.conversationId !== conversationId || record.type !== 'input')
            throw new ChannelError('not_found', 'Queued input not found')
          admit()
          const outcome = await submission.abort(hostContext)
          if (outcome === 'aborted') return
          const settled = await submission.status(hostContext)
          if (
            settled.status !== 'unanswered' ||
            settled.reason !== 'aborted' ||
            settled.entry !== undefined
          )
            throw new ChannelError('conflict', 'Input is already being processed or has finished')
        }),
      stop: (id) =>
        mutation('stop', async (admit) => {
          const conversationId = ensureId(id)
          await requireConversation(conversationId)
          for (;;) {
            const own = (await harness.inspect(hostContext)).tasks.filter(
              ({ record }) =>
                record.conversationId === conversationId && !record.owner && !record.background,
            )
            if (own.length === 0) break
            for (const { record } of own) {
              admit()
              await harness.abortTask(record.id, hostContext)
              await harness.waitForTask(record.id, hostContext)
            }
          }
        }),
      compact: async (id, input: CompactRequest) => {
        const taskId = await compactTask(id, input)
        return { operationId: Buffer.from(`1:${id}:${taskId}`).toString('base64url') }
      },
      history: (id, page: HistoryRequest) =>
        operation('history', async () => {
          const conversationId = ensureId(id)
          const conversation = await requireConversation(conversationId)
          if (!page || typeof page !== 'object' || Array.isArray(page))
            throw new ChannelError('invalid_input', 'Invalid history request')
          if (page.direction !== 'older' && page.direction !== 'newer')
            throw new ChannelError('invalid_input', 'Invalid history direction')
          const limit = historyLimit(page.limit)
          if (page.cursor !== undefined && typeof page.cursor !== 'string')
            throw new ChannelError('invalid_input', 'Invalid history cursor')
          const boundary =
            page.cursor === undefined ? undefined : parseHistoryCursor(page.cursor, conversationId)
          if (
            (page.direction === 'older' && boundary === 1) ||
            (page.direction === 'newer' && boundary === Number.MAX_SAFE_INTEGER)
          )
            return { items: [] }
          const query = {
            order: page.direction === 'older' ? ('descending' as const) : ('ascending' as const),
            ...(boundary === undefined
              ? {}
              : page.direction === 'older'
                ? { maxEntryId: (boundary - 1) as EntryId }
                : { minEntryId: (boundary + 1) as EntryId }),
          }
          const scan = await conversation.entries(query, limit + 1, undefined, hostContext)
          const entries = scan.items.slice(0, limit)
          return projectHistoryScan(conversationId, entries, scan.items.length > limit)
        }),
      watch: (id, watchOptions) => watch(id, watchOptions?.signal),
    },
    models: {
      list: () => operation('models', () => listChannelModels(host.modelRuntime)),
    },
  }

  function projectSubmissionState(record: SubmissionRecord): SubmissionState {
    if (record.status === 'queued') return { status: 'queued' }
    if (record.status === 'placed') return { status: 'active' }
    if (record.status === 'done') {
      if (record.type !== 'input' || record.answer === undefined)
        throw new ChannelError('not_found', 'Submission not found')
      return { status: 'answered', answerRef: String(record.answer) }
    }
    return {
      status: 'unanswered',
      reason: safeReasons.has(record.reason) ? record.reason : 'failed',
    }
  }

  return {
    channelHost,
    conversations: snapshotSummaries,
    taskGraph: tasks,
    openAdmission,
    closeAdmission,
    read: (work) => {
      ensureOpen()
      return track(work)
    },
    submit: submitInput,
    compact: compactTask,
    refreshConversation: async (id: number) => {
      await track(async () => {
        const conversationId = ensureId(id)
        await requireConversation(conversationId)
        await refreshing
        await refreshConversations(new Set([conversationId]))
      })
    },
    close() {
      closeAdmission()
      closing ??= (async () => {
        if (activeCalls > 0) await new Promise<void>((resolve) => (callDrain = resolve))
        if (closed) return
        closed = true
        clearTimeout(graphTimer)
        graphObservation.detach()
        detachCommits()
        for (const stop of activeWatches) stop()
        await refreshing
        await projectIndex.flush()
      })()
      return closing
    },
  }
}

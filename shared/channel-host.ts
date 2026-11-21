/** Trusted in-process channel boundary. IDs are opaque within this installation. */
export type ConversationId = number
export type SubmissionId = number
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ChannelErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'internal'
export class ChannelError extends Error {
  constructor(publicCode: ChannelErrorCode, message: string) {
    super(message)
    this.code = publicCode
    this.name = 'ChannelError'
  }
  readonly code: ChannelErrorCode
}
const codes: readonly string[] = [
  'invalid_input',
  'not_found',
  'conflict',
  'unavailable',
  'internal',
]
/**
 * Whether `error` is a `ChannelError` or a subclass. An extension loads its own copy of this module, so a core error
 * fails `instanceof` there; its name and code still tell.
 */
export function isChannelError(error: unknown): error is ChannelError {
  return (
    error instanceof Error &&
    (error.name === 'ChannelError' || error.name === 'InputLimitError') &&
    codes.includes((error as { code?: unknown }).code as string)
  )
}
export interface ConversationSummary {
  id: ConversationId
  title?: string
  label?: string
  cwd?: string
  busy: boolean
  inputAt?: number
  answerAt?: number
  parentConversationId?: ConversationId
  branchOf?: { conversationId: ConversationId; at: number }
  ownerTaskId?: number
}
export interface ModelReference {
  provider: string
  modelId: string
}
export interface ConversationConfiguration {
  model?: ModelReference
  thinkingLevel?: ThinkingLevel
  definition?: string
  preset?: string
}
export interface ConversationDetails {
  summary: ConversationSummary
  configuration: ConversationConfiguration
}
export interface CreateConversationRequest {
  title?: string
  cwd?: string
  definition?: string | null
  preset?: string | null
  model?: ModelReference
  thinkingLevel?: ThinkingLevel
}
export interface CreateConversationResponse {
  id: ConversationId
}
export interface ConfigureConversationRequest {
  model?: ModelReference
  thinkingLevel?: ThinkingLevel
  definition?: string | null
  preset?: string | null
}
export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface ModelCost extends ModelCostRates {
  tiers?: (ModelCostRates & { inputTokensAbove: number })[]
}
export interface ModelDescriptor {
  provider: string
  id: string
  name: string
  available: boolean
  contextWindow: number
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  cost: ModelCost
}
export interface InputImage {
  mimeType: string
  data: string
}
/** Source fields are descriptive, not authentication. */
export type InputSource = {
  channel: string
  instanceId?: string
  senderId?: string
  chatId?: string
  threadId?: string
  messageId?: string
  replyToMessageId?: string
  device?: string
  login?: string
  address?: string
}
export interface SubmitRequest {
  text: string
  images?: InputImage[]
  whenBusy?: 'steer' | 'followUp'
  requestId?: string
  source?: InputSource
}
export interface SubmissionReceipt {
  conversationId: ConversationId
  submissionId: SubmissionId
}
export type SubmissionState =
  | { status: 'queued' | 'active' }
  | { status: 'answered'; answerRef: string }
  | { status: 'unanswered'; reason?: string }
export interface CompactRequest {
  instructions?: string
}
export interface CompactResponse {
  operationId: string
}
export type HistoryContent = { type: 'text'; text: string } | { type: 'image'; image: InputImage }
export type HistoryItem =
  | { entryRef: string; type: 'user' | 'assistant'; timestamp?: number; content: HistoryContent[] }
  | { entryRef: string; type: 'tool' | 'other'; kind: string; timestamp?: number; summary?: string }
export interface HistoryRequest {
  direction: 'older' | 'newer'
  cursor?: string
  limit?: number
}
export interface HistoryResponse {
  items: HistoryItem[]
  scanPosition?: string
  continuation?: string
}
export interface WatchOptions {
  signal?: AbortSignal
}
export interface ConversationOutput {
  activity: { busy: boolean; inputAt?: number; answerAt?: number }
  configuration: ConversationConfiguration
  latestHistoryCursor?: string
  inFlight?: { streamRef: string; text: string }
}
export interface ChannelHost {
  conversations: {
    list(): Promise<ConversationSummary[]>
    create(input: CreateConversationRequest): Promise<CreateConversationResponse>
    get(id: ConversationId): Promise<ConversationDetails>
    configure(
      id: ConversationId,
      change: ConfigureConversationRequest,
    ): Promise<ConversationConfiguration>
    submit(id: ConversationId, input: SubmitRequest): Promise<SubmissionReceipt>
    submission(id: ConversationId, submissionId: SubmissionId): Promise<SubmissionState>
    cancelQueuedInput(id: ConversationId, submissionId: SubmissionId): Promise<void>
    stop(id: ConversationId): Promise<void>
    compact(id: ConversationId, input: CompactRequest): Promise<CompactResponse>
    history(id: ConversationId, page: HistoryRequest): Promise<HistoryResponse>
    watch(id: ConversationId, options?: WatchOptions): AsyncIterable<ConversationOutput>
  }
  models: { list(): Promise<ModelDescriptor[]> }
}

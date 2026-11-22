/**
 * Subagents in the browser: the standing agents' conversations, and the actions that open a standing agent and read,
 * save and delete agent definitions. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

export type DestinationAddress = number | string
/** Read the current default address without opening a conversation. */
export const DefaultDestinationAction = actionRef<null, { address?: DestinationAddress }>(
  'subagents',
  'defaultDestination',
)
/** A conversation can be addressed by ID, #id or @name. Channel delivery is not supported yet. */
export type Destination =
  | { kind: 'conversation'; address: DestinationAddress }
  | { kind: 'channel'; channel: string; instanceId: string; address: string; threadId?: string }

/** Where a definition file lives: shipped with Ultimate, in the user's home, or in the project. */
export type Source = 'builtin' | 'user' | 'project'
/** Where a definition can be saved. */
export type Scope = 'user' | 'project'
/** A model as `provider` and `modelId`. */
export type ModelRef = { provider: string; modelId: string }
/** A parsed agent definition, without its instructions. */
export type Definition = {
  name: string
  description: string
  path: string
  source: Source
  model?: ModelRef
  thinking?: string
  /** The model family its file names (lib/families.ts). */
  family?: string
  /** What it runs on once the families apply: its pin, its family, else the default. */
  runs?: { family?: string; model?: ModelRef; thinking?: string; via: 'pin' | 'family' }
  tools?: string[]
  denyTools?: string[]
  /** The skills it is given by name; absent, every skill. */
  skills?: string[]
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
  /** Overlay files merged into it, in order; saving it writes an overlay, not a whole copy. */
  overlays?: string[]
}
/** A definition file that failed to parse, with the reason. */
export type Invalid = { name: string; path: string; source: Source; error: string }
/** What `start` can name, the files that failed to parse, and what the config form needs. */
export type Discovery = {
  definitions: Definition[]
  errors: Invalid[]
  /** The main conversation's model and tools; a definition may list a subset of the tools. */
  main: { model?: ModelRef; thinking?: string; tools: { name: string; description: string }[] }
  /** The project's skills a definition may list. */
  skills: { name: string; description: string }[]
  /** The folder each scope saves to. */
  scopes: Record<Scope, string>
  /** The user's choice on the project's `.ultimate/` setup; the project scope needs it trusted. */
  projectSetup: 'trusted' | 'declined' | 'undecided'
}
/** The definition of one name: the one that applies, a later file of that name that fails to parse, the raw file. */
export type Shown = {
  definition?: Definition & { instructions: string }
  invalid?: Invalid
  source: Source
  path: string
  raw: string
  /** The scopes with a file of this name, in the order they apply. */
  files: Source[]
}
/** The frontmatter `saveDefinition` writes; `model` is `provider/modelId`. */
export type DefinitionFields = {
  description: string
  model?: string
  thinking?: string
  family?: string
  tools?: string[]
  denyTools?: string[]
  /** Null selects all skills; omitted leaves the saved choice unchanged. */
  skills?: string[] | null
  isolate?: 'none' | 'worktree'
  resident?: boolean
  fast?: boolean
  summaries?: boolean
}

/**
 * Conversation `id` was configured to run as an agent: a subagent or automation run (`child`, `parent` the conversation
 * that owns it), a new standing agent's conversation (`standing`), or a branch (`branch`, `parent` the conversation it
 * forked from). `agent` is the definition or label, `model` `provider/modelId`. Emitted in the creating commit.
 */
export const Started = defineEvent<{
  id: number
  agent: string
  model?: string
  thinking?: string
  parent?: number
  kind: 'child' | 'standing' | 'branch'
}>('subagents.started')

/**
 * What a `subagent start` child was started on: its model id (`gpt-6-astra`) and whether it was made on the fly, without
 * a definition (`adhoc`).
 */
export type Run = { model?: string; adhoc?: true }
/** `{ [conversationId]: Run }` of the children `subagent start` made, on conversation 1. */
export const RunsDoc = docRef<Record<string, Run>>('subagents.runs')

/** `{ [name]: conversationId }` of the standing agents, on conversation 1. */
export const StandingDoc = docRef<Record<string, number>>('ultimate.standing-agents')
/** The agent definition a conversation selected, if any. */
export const ProfileDoc = docRef<{ definition?: string; adhoc?: true }>('ultimate.agent-profile')

/** `{ name }` → the conversation id of standing agent `name`, created or refreshed from its definition. */
export const StandingAction = actionRef<{ name: string }, number>('subagents', 'standing')
/** Standing name and expected conversation ID → new conversation ID. */
export const ReplaceStandingAction = actionRef<{ name: string; expected: number }, number>(
  'subagents',
  'replaceStanding',
)
/** Open conversation ID → fresh conversation ID, with its standing address moved if it has one. */
export const ClearConversationAction = actionRef<{ id: number }, number>(
  'subagents',
  'clearConversation',
)
/** No arguments → every definition, the files that failed to parse, and the main agent's model and tools. */
export const DefinitionsAction = actionRef<null, Discovery>('subagents', 'definitions')
/** `{ name }` → the definition that applies to `name`, its source and path, the raw file, and the scopes with one. */
export const DefinitionAction = actionRef<{ name: string }, Shown>('subagents', 'definition')
/**
 * `{ name, scope, frontmatter, instructions, create?, overlay? }` → the saved definition: write
 * `<scope>/agents/<name>.md`. Invalid input writes nothing; with `create`, an existing definition of that name fails
 * it; with `overlay`, a definition from another scope gets an overlay holding only what differs, not a whole copy.
 */
export const SaveDefinitionAction = actionRef<
  {
    name: string
    scope: Scope
    frontmatter: DefinitionFields
    instructions: string
    create?: boolean
    overlay?: boolean
  },
  Definition
>('subagents', 'saveDefinition')
/** `{ name, scope }` → `{ path }`: delete a user or project definition; another of that name applies again. */
export const DeleteDefinitionAction = actionRef<{ name: string; scope: Scope }, { path: string }>(
  'subagents',
  'deleteDefinition',
)

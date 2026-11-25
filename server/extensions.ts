import { readFile, realpath } from 'node:fs/promises'
import { existsSync, lstatSync, watch as watchDirectory } from 'node:fs'
import { compareExtensions, discoverExtensions } from './discovery.ts'
import { projectSetup, projectSettings } from './project-setup.ts'
import type { ProjectAccess } from './project-setup.ts'
import { discoveryRoots, projects } from './project.ts'
import type { ProjectInfo } from './project.ts'
import { extensionSettingsFiles } from './extension-settings.ts'
import { projectSkills } from './skills.ts'
import type { ScopedSkill } from './skills.ts'
import { watchRoots } from './watch-roots.ts'
import { actionExec } from './actions.ts'
import type { ExtensionAction } from './actions.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { join, resolve } from 'node:path'
import type {
  ConversationDocToken,
  Extension,
  Harness,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { ViteDevServer } from 'vite-plus'
import type { ConversationSummary, ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { PreparedHost } from './harness.ts'
import { SourceStatusApi } from '../shared/source-status.ts'
import { PersonaApplication } from '../shared/persona-application.ts'
import type { ConfigurationServices } from './conversation-configuration.ts'
import { Metadata } from './metadata.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Access } from './request-security.ts'
import { EventFeed, eventLog } from './events.ts'
import { contractOutline } from '../lib/api-files.ts'
import type { EventHost } from './events.ts'
import { extensionApis } from './extension-apis.ts'
import type { TraceReader } from './trace.ts'
import type { Api, Catalogue } from '../shared/extension-api.ts'
import { inExtensionTests } from '../shared/extension-api.ts'
import type { Device } from '../shared/events.ts'
import { ChannelError } from '../shared/channel-host.ts'
import type { ConversationOutput } from '../shared/channel-host.ts'
import type { LocalChannelHost } from './conversation-host.ts'
import type { WebChannelRuntime } from './web-channel.ts'

import { secretMetadata } from '../lib/secrets.ts'

export type ExtensionHost = Pick<
  PreparedHost,
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'home'
  | 'modelRuntime'
  | 'settings'
  | 'build'
  | 'uiState'
  | 'scanSubmissions'
  | 'models'
  | 'restart'
  | 'chapter'
> & {
  access: Pick<Access, 'allow'>
  notice(message: string, options?: { untilSecretSet?: string }): void
  /**
   * Provide the service of `api`. Facet scope only: staged until the facet installs, replaced on reload, kept when a
   * reload fails, and removed when the facet is disabled, removed or closed.
   */
  implement<S>(api: Api<string, S>, value: NoInfer<S>): void
  /** A handle to the current provider of `api`; throws while none is enabled, except during facet setup. */
  need<S>(api: Api<string, S>): S
  /** A handle to the current provider of `api`, or undefined while none is enabled. */
  want<S>(api: Api<string, S>): S | undefined
  /** Who provides, needs and wants each API, plus missing providers and dependency cycles. */
  catalogue(): Catalogue
  /** The recorded calls: services, actions, reactor runs and tools. */
  trace: TraceReader
  resource<T>(key: string, create: () => T): T
  /** Run `callback` each time the harness opens, at once when it is open; the server serves once it settles. */
  onOpen(callback: () => Promise<void>): void
  /** Run finite setup after open callbacks and shared runtime admission, once per active harness activation. */
  onReady(callback: () => Promise<void>): void
  /** The current scoped conversation service; operations fail unavailable outside an open harness activation. */
  channelHost(): LocalChannelHost
  /** The runtime seen by the optional web channel; only the `web` extension may use it. */
  webChannel(): WebChannelRuntime
  /** Run `callback` each time before the harness closes while the process stays: on a core swap. */
  onRelease(callback: () => Promise<void>): void
  onClose(cleanup: () => Promise<void>): void
  /** Run `callback` each time an extension's server facet fails to load, with its name and error; facet-scoped. */
  onLoadError(callback: (name: string, error: string) => void): void
  /**
   * Run `callback` and wait for it before each extension reload, web build and restart, so none of them reads a
   * checkout or packages that are still being written. When it throws, a reload or build goes on with a notice and a
   * restart is refused with the message; facet-scoped.
   */
  onBeforeLoad(callback: () => Promise<void>): void
  /**
   * Skills for working directory `cwd`: enabled extensions' `skills/` folders, then `.pi/skills`, user and trusted
   * project skills, each with its `scope` and `overrides`.
   */
  skills(cwd: string): ScopedSkill[]
  harness(): Harness
  system(): SystemInfo
  /** Track changes to the local web endpoint for the lifetime of this facet. */
  watchWebEndpoint(callback: (url: string | undefined) => void): () => void
  /** Summaries of every conversation, as the web's conversation list shows them; empty until the harness is open. */
  conversations(): ConversationSummary[]
  /** Read JSON manifests in the user's central project homes, never another project's SQLite; unknown roots remain absent. Includes this home and live supervisor URLs. */
  projects(): Promise<ProjectInfo[]>
  /** Discovered extensions, including disabled project folders, with effective deciding layers. */
  extensions(): ExtensionInfo[]
  /** Installation policy for this project's trust and preset identity. */
  projectAccess?: ProjectAccess
  /** Project setup availability, the trust decision, and capped README. */
  projectSetup(): ReturnType<typeof projectSetup>
  /** Parsed project settings only after a local decision; otherwise empty. Invalid JSON reports a notice and returns empty. */
  projectSettings(): Promise<JsonObject>
  /** Read-only inventory of project folders, including replacements of active extensions. */
  projectExtensions(): Promise<ExtensionInfo[]>
  /** Remember the local/global choice and apply it through the live settings reload path. */
  setProjectDecision(local: boolean): Promise<void>
  /** Apply settings writes to the registry, browser facets, and styles before returning. */
  reloadExtensions(): Promise<void>
  /** Call an installed extension action on behalf of a conversation; rejects user-only actions. */
  invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: number,
  ): Promise<unknown>
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
  metadata: typeof Metadata
} & EventHost
const runOpener = async (callback: () => Promise<void>) => {
  try {
    await callback()
    return true
  } catch (error) {
    console.error('Extension onOpen:', error)
    return false
  }
}
const runReleaser = (callback: () => Promise<void>) =>
  callback().catch((error: unknown) => console.error('Extension onRelease:', error))
/** Attach listeners to Vite's current watcher and to each replacement; `attach` returns their removal. */
export type Watch = (attach: (watcher: ViteDevServer['watcher']) => () => void) => () => void
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void | Promise<void>,
  runtime: Pick<
    ExtensionHost,
    | 'harness'
    | 'system'
    | 'conversations'
    | 'access'
    | 'channelHost'
    | 'webChannel'
    | 'watchWebEndpoint'
  >,
  watch: Watch,
  notice: (message: string) => void = () => {},
  /** Bring the web bundle up to date with the settings just applied. */
  rebuildWeb: () => Promise<void> = async () => {},
) {
  const trace = host.callTrace
  const log = eventLog(runtime.harness, trace.run, trace.keep)
  const roots = discoveryRoots(host.ultimateRoot, host.projectRoot, host.userHome)
  const directories = roots.map((root) => join(root.path, 'extensions'))
  const provided = new Map<ExtensionHost, Map<string, unknown>>()
  const providers = new Map<string, { owner: ExtensionHost; value: unknown }>()
  const facetHosts = new Map<string, ExtensionHost>()
  const subscriptions = new Map<ExtensionHost, Set<() => void>>()
  const facetOpeners = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetReadies = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetReleasers = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetCleanups = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetCalls = new Map<ExtensionHost, Set<Promise<unknown>>>()
  const facetWatchStops = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const disposedFacets = new WeakSet<ExtensionHost>()
  type FacetOpenState = {
    activation: number
    completed: Set<() => Promise<void>>
    failed: boolean
    running?: Promise<void>
  }
  type ReadyState = {
    activation: number
    completed: Set<() => Promise<void>>
    running?: Promise<void>
  }
  const facetOpenStates = new Map<ExtensionHost, FacetOpenState>()
  const facetReadyStates = new Map<ExtensionHost, ReadyState>()
  const processOpeners = new Set<() => Promise<void>>()
  const processReadies = new Set<() => Promise<void>>()
  let processOpenState: FacetOpenState | undefined
  let processReadyState: ReadyState | undefined
  let activation = 0
  let open = false
  let ready = false
  /** Each facet's distinct notice messages, and whether each is recorded as an event yet. */
  type FacetNotice = { recorded: boolean; untilSecretSet?: string }
  const facetNotices = new Map<ExtensionHost, Map<string, FacetNotice>>()
  let closed = false
  const extensionOf = (facetHost: ExtensionHost) =>
    [...facetHosts].find(([, current]) => current === facetHost)?.[0]
  const currentFacet = (facetHost: ExtensionHost, generation: number) =>
    !closed &&
    open &&
    activation === generation &&
    !disposedFacets.has(facetHost) &&
    [...facetHosts.values()].includes(facetHost)
  const openState = (facetHost: ExtensionHost, generation: number) => {
    let state = facetOpenStates.get(facetHost)
    if (!state || state.activation !== generation) {
      state = { activation: generation, completed: new Set(), failed: false }
      facetOpenStates.set(facetHost, state)
    }
    return state
  }
  const readyState = (facetHost: ExtensionHost, generation: number) => {
    let state = facetReadyStates.get(facetHost)
    if (!state || state.activation !== generation) {
      state = { activation: generation, completed: new Set() }
      facetReadyStates.set(facetHost, state)
    }
    return state
  }
  function runFacetOpeners(facetHost: ExtensionHost, generation: number): Promise<void> {
    const state = openState(facetHost, generation)
    if (state.running) return state.running
    state.running = (async () => {
      for (;;) {
        if (!currentFacet(facetHost, generation)) break
        const pending = [...(facetOpeners.get(facetHost) ?? [])].filter(
          (callback) => !state.completed.has(callback),
        )
        if (!pending.length) break
        for (const callback of pending) state.completed.add(callback)
        const results = await Promise.all(pending.map(runOpener))
        if (results.some((success) => !success)) state.failed = true
      }
    })().finally(() => {
      state.running = undefined
    })
    return state.running
  }
  function runFacetReadies(facetHost: ExtensionHost, generation: number): Promise<void> {
    const state = readyState(facetHost, generation)
    if (state.running) return state.running
    state.running = (async () => {
      await runFacetOpeners(facetHost, generation)
      if (!ready || !currentFacet(facetHost, generation) || openState(facetHost, generation).failed)
        return
      for (;;) {
        if (!ready || !currentFacet(facetHost, generation)) break
        const pending = [...(facetReadies.get(facetHost) ?? [])].filter(
          (callback) => !state.completed.has(callback),
        )
        if (!pending.length) break
        for (const callback of pending) state.completed.add(callback)
        for (const callback of pending) {
          if (!ready || !currentFacet(facetHost, generation)) return
          try {
            await callback()
          } catch (error) {
            const message = `Extension onReady failed: ${String(error)}`
            console.error(message)
            try {
              facetHost.notice(message)
            } catch (noticeError) {
              console.error('Reporting extension readiness failure:', noticeError)
            }
          }
        }
      }
    })().finally(() => {
      state.running = undefined
    })
    return state.running
  }
  function runProcessOpeners(generation: number): Promise<void> {
    const state = (processOpenState =
      processOpenState?.activation === generation
        ? processOpenState
        : { activation: generation, completed: new Set(), failed: false })
    if (state.running) return state.running
    state.running = (async () => {
      for (;;) {
        if (closed || !open || activation !== generation) break
        const pending = [...processOpeners].filter((callback) => !state.completed.has(callback))
        if (!pending.length) break
        for (const callback of pending) state.completed.add(callback)
        await Promise.all(pending.map(runOpener))
      }
    })().finally(() => {
      state.running = undefined
    })
    return state.running
  }
  function runProcessReadies(generation: number): Promise<void> {
    const state = (processReadyState =
      processReadyState?.activation === generation
        ? processReadyState
        : { activation: generation, completed: new Set() })
    if (state.running) return state.running
    state.running = (async () => {
      await runProcessOpeners(generation)
      for (;;) {
        if (closed || !open || !ready || activation !== generation) break
        const pending = [...processReadies].filter((callback) => !state.completed.has(callback))
        if (!pending.length) break
        for (const callback of pending) state.completed.add(callback)
        for (const callback of pending) {
          if (closed || !open || !ready || activation !== generation) return
          try {
            await callback()
          } catch (error) {
            const message = `Process onReady failed: ${String(error)}`
            console.error(message)
            notice(message)
          }
        }
      }
    })().finally(() => {
      state.running = undefined
    })
    return state.running
  }
  const callChannel = <T>(
    facetHost: ExtensionHost,
    work: (channel: LocalChannelHost) => Promise<T>,
  ) => {
    const calls = facetCalls.get(facetHost)
    if (!calls || disposedFacets.has(facetHost))
      return Promise.reject(new ChannelError('unavailable', 'Conversation service is unavailable'))
    let promise: Promise<T>
    try {
      promise = work(runtime.channelHost())
    } catch (error) {
      return Promise.reject(error)
    }
    let tracked: Promise<T>
    tracked = promise.finally(() => calls.delete(tracked))
    calls.add(tracked)
    return tracked
  }
  const scopedChannelHost = (facetHost: ExtensionHost): LocalChannelHost => ({
    conversations: {
      list: () => callChannel(facetHost, (channel) => channel.conversations.list()),
      create: (input, bind) =>
        callChannel(facetHost, (channel) => channel.conversations.create(input, bind)),
      get: (id) => callChannel(facetHost, (channel) => channel.conversations.get(id)),
      configure: (id, change) =>
        callChannel(facetHost, (channel) => channel.conversations.configure(id, change)),
      submit: (id, input) =>
        callChannel(facetHost, (channel) => channel.conversations.submit(id, input)),
      submission: (id, submissionId) =>
        callChannel(facetHost, (channel) => channel.conversations.submission(id, submissionId)),
      cancelQueuedInput: (id, submissionId) =>
        callChannel(facetHost, (channel) =>
          channel.conversations.cancelQueuedInput(id, submissionId),
        ),
      stop: (id) => callChannel(facetHost, (channel) => channel.conversations.stop(id)),
      compact: (id, input) =>
        callChannel(facetHost, (channel) => channel.conversations.compact(id, input)),
      history: (id, page) =>
        callChannel(facetHost, (channel) => channel.conversations.history(id, page)),
      watch: (id, options) => {
        const watches = facetWatchStops.get(facetHost)
        if (!watches || disposedFacets.has(facetHost))
          throw new ChannelError('unavailable', 'Conversation service is unavailable')
        const updates = runtime.channelHost().conversations.watch(id, options)
        const iterator = updates[Symbol.asyncIterator]()
        let stopped = false
        const finished = { value: undefined, done: true } as const
        // Facet disposal ends the watch; the backend ends it on release or shutdown.
        const stop = async () => {
          if (stopped) return
          stopped = true
          watches.delete(stop)
          await iterator.return?.()
        }
        watches.add(stop)
        const scoped: AsyncIterableIterator<ConversationOutput> = {
          [Symbol.asyncIterator]() {
            return this
          },
          next: async () => {
            if (stopped) return finished
            try {
              const result = await callChannel(facetHost, () => iterator.next())
              if (result.done) await stop()
              return result
            } catch (error) {
              await stop()
              throw error
            }
          },
          return: async () => {
            await stop()
            return finished
          },
        }
        return scoped
      },
    },
    models: {
      list: () => callChannel(facetHost, (channel) => channel.models.list()),
    },
  })
  const apis = extensionApis(
    (name) => {
      const service = providers.get(name)
      const extension = service && extensionOf(service.owner)
      return extension ? { extension, value: service.value } : undefined
    },
    () =>
      [...providers].flatMap(([name, { owner }]) => {
        const extension = extensionOf(owner)
        return extension ? [[name, extension] as [string, string]] : []
      }),
    (owner) => [...facetHosts.values()].includes(owner as ExtensionHost),
    trace.run,
  )
  let missingApis = new Set<string>()
  const dispose = async (facetHost: ExtensionHost | undefined) => {
    if (!facetHost) return
    disposedFacets.add(facetHost)
    apis.dispose(facetHost)
    for (const [name, service] of providers) if (service.owner === facetHost) providers.delete(name)
    provided.delete(facetHost)
    for (const stop of subscriptions.get(facetHost) ?? []) stop()
    subscriptions.delete(facetHost)
    for (const stop of facetWatchStops.get(facetHost) ?? []) await stop()
    facetWatchStops.delete(facetHost)
    const pending = [
      facetOpenStates.get(facetHost)?.running,
      facetReadyStates.get(facetHost)?.running,
    ].filter((task): task is Promise<void> => task !== undefined)
    await Promise.all(pending)
    await Promise.allSettled(facetCalls.get(facetHost) ?? new Set<Promise<unknown>>())
    facetCalls.delete(facetHost)
    facetOpeners.delete(facetHost)
    facetReadies.delete(facetHost)
    facetOpenStates.delete(facetHost)
    facetReadyStates.delete(facetHost)
    for (const callback of facetReleasers.get(facetHost) ?? []) releasers.delete(callback)
    facetReleasers.delete(facetHost)
    for (const cleanup of facetCleanups.get(facetHost) ?? []) {
      try {
        await cleanup()
      } catch (error) {
        notice(`Extension cleanup failed: ${String(error)}`)
      }
    }
    facetCleanups.delete(facetHost)
    facetNotices.delete(facetHost)
  }
  const scope = (name: string): ExtensionHost => {
    const stops = new Set<() => void>()
    let sharedResource = false
    const facetHost = {
      ...extensionHost,
      get chapter() {
        return extensionHost.chapter
      },
      implement: (api, value) => {
        provided.get(facetHost)!.set(api.name, value)
        if (facetHosts.get(name) === facetHost) providers.set(api.name, { owner: facetHost, value })
      },
      need: <S>(api: Api<string, S>): S =>
        apis.need(facetHost, name, api, facetHosts.get(name) !== facetHost),
      want: <S>(api: Api<string, S>): S | undefined => apis.want(facetHost, name, api),
      notice: (message, options) => {
        // Each distinct message once per facet load: a notice raised by a commit watcher cannot loop through its event.
        // One raised while storage is closed is recorded when it opens.
        const messages = facetNotices.get(facetHost)
        // Pending facet work can finish after reload or shutdown; it must not revive a disposed facet's notices.
        if (!messages) return
        if (!messages.has(message)) {
          messages.set(message, { recorded: open, ...options })
          if (open) log.notice(name, message)
        }
        notice(message)
        void Promise.resolve(changed()).catch((error: unknown) =>
          console.error('Publishing extension changes failed:', error),
        )
      },
      resource: <T>(key: string, create: () => T) =>
        extensionHost.resource(key, () => {
          const previous = sharedResource
          sharedResource = true
          try {
            return create()
          } finally {
            sharedResource = previous
          }
        }),
      access: {
        allow: (rule) => {
          const remove = runtime.access.allow(rule)
          const stop = () => {
            remove()
            stops.delete(stop)
          }
          stops.add(stop)
          return stop
        },
      },
      onOpen: (callback) => {
        if (sharedResource) extensionHost.onOpen(callback)
        else {
          const callbacks = facetOpeners.get(facetHost)
          if (!callbacks || disposedFacets.has(facetHost)) return
          callbacks.add(callback)
          if (currentFacet(facetHost, activation))
            // oxlint-disable-next-line typescript/no-floating-promises -- lifecycle runners report callback failures.
            void runFacetOpeners(facetHost, activation).then(() =>
              ready ? runFacetReadies(facetHost, activation) : undefined,
            )
        }
      },
      onReady: (callback) => {
        if (sharedResource) extensionHost.onReady(callback)
        else {
          const callbacks = facetReadies.get(facetHost)
          if (!callbacks || disposedFacets.has(facetHost)) return
          callbacks.add(callback)
          if (ready && currentFacet(facetHost, activation))
            // oxlint-disable-next-line typescript/no-floating-promises -- lifecycle runners report callback failures.
            void runFacetReadies(facetHost, activation)
        }
      },
      channelHost: (): LocalChannelHost =>
        sharedResource ? extensionHost.channelHost() : scopedChannelHost(facetHost),
      webChannel: () => {
        if (name !== 'web') throw new Error('Only the web extension serves the browser')
        return runtime.webChannel()
      },
      onRelease: (callback) => {
        if (sharedResource) extensionHost.onRelease(callback)
        else {
          facetReleasers.get(facetHost)!.add(callback)
          releasers.add(callback)
        }
      },
      onClose: (cleanup) => {
        if (sharedResource) extensionHost.onClose(cleanup)
        else facetCleanups.get(facetHost)!.add(cleanup)
      },
      watchWebEndpoint: (callback) => {
        const stop = runtime.watchWebEndpoint(callback)
        stops.add(stop)
        return () => {
          stops.delete(stop)
          stop()
        }
      },
      onLoadError: (callback) => {
        loadErrorListeners.add(callback)
        stops.add(() => loadErrorListeners.delete(callback))
      },
      onBeforeLoad: (callback) => {
        beforeLoad.add(callback)
        stops.add(() => beforeLoad.delete(callback))
      },
      react: (reactorName, tokens, handler, options) => {
        const reactor = log.reactor(`${name}/${reactorName}`, tokens, handler, options)
        facetHost.onOpen(reactor.start)
        facetHost.onRelease(reactor.stop)
        stops.add(reactor.stop)
      },
    } satisfies ExtensionHost
    provided.set(facetHost, new Map())
    subscriptions.set(facetHost, stops)
    facetOpeners.set(facetHost, new Set())
    facetReadies.set(facetHost, new Set())
    facetReleasers.set(facetHost, new Set())
    facetCleanups.set(facetHost, new Set())
    facetCalls.set(facetHost, new Set())
    facetWatchStops.set(facetHost, new Set())
    facetNotices.set(facetHost, new Map())
    return facetHost
  }
  const actions = new Map<string, Record<string, ExtensionAction>>()
  const userActions = new Map<string, string[]>()
  /** Read-only actions a surface polls: the trace counts their successful calls instead of writing them. */
  const pollActions = new Map<string, string[]>()
  const settingsReloads = new Set<string>()
  const records = new Map<string, ExtensionInfo>()
  /** Each loaded extension's folder with symlinks resolved, where Vite keys its modules. */
  const targets = new Map<string, string>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const findDoc = (kind: string) =>
    [
      EventFeed as never as ConversationDocToken<JsonObject>,
      // A conversation's live round without its transcript, for watchers of many conversations (the sound of agents).
      LiveDoc as never as ConversationDocToken<JsonObject>,
      ...[...documents.values()].flat(),
    ].find((doc) => doc.definition.kind === kind)
  const loadErrorListeners = new Set<(name: string, error: string) => void>()
  const beforeLoad = new Set<() => Promise<void>>()
  /** Wait for the `onBeforeLoad` callbacks; the message of the first that failed. */
  async function prepared() {
    let failed: string | undefined
    for (const callback of beforeLoad)
      try {
        await callback()
      } catch (error) {
        failed ??= error instanceof Error ? error.message : String(error)
      }
    return failed
  }
  let unprepared: string | undefined
  /** `prepared` for a reload or a web build: it goes on either way, and each failure is said once, not on every save. */
  async function preparedToLoad() {
    const failed = await prepared()
    if (failed && failed !== unprepared) notice(`Loading as it is: ${failed}`)
    unprepared = failed
    // Vite's resolver remembers where each package resolved to. pnpm installs a changed (patched) package into a new
    // folder and moves the link, so a facet reloaded after an install kept importing the old folder: "useUrl is not a
    // function" in 19 of 56 patch landings on a scratch host (#545608). Telling the resolver that node_modules
    // changed makes it look again; that costs a few stats per reload.
    const modules = join(host.ultimateRoot, 'node_modules')
    for (const environment of Object.values(vite.environments))
      await environment.pluginContainer.watchChange(modules, { event: 'create' })
  }
  const releasers = new Set<() => Promise<void>>()
  const cleanups = new Set<() => Promise<void>>()
  const resources = new Map<string, unknown>()
  async function invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: number,
    caller = 'ui',
    device?: Device,
  ) {
    const table = actions.get(name)
    const fn = table && Object.hasOwn(table, action) ? table[action] : undefined
    if (!fn) throw new Error(`Unknown extension action: ${name}/${action}`)
    if (
      conversationId !== undefined &&
      (!Number.isSafeInteger(conversationId) || conversationId < 1)
    )
      throw new Error('Invalid conversationId')
    const call = { caller, callee: name, name: `${name}/${action}`, args, conversationId }
    const poll = pollActions.get(name)?.includes(action)
    return trace.run({ kind: 'action', ...call, ...(poll ? { poll } : {}) }, () =>
      fn(args, {
        host: facetHosts.get(name)!,
        conversationId,
        ...(device ? { device } : {}),
        signal,
        exec: async (command, commandArgs, options) => {
          const agent =
            conversationId === undefined
              ? undefined
              : await runtime
                  .harness()
                  .snapshot(AgentDoc, conversationId as ConversationId, BACKGROUND_CONTEXT)
          return actionExec(options?.cwd ?? agent?.cwd ?? host.projectRoot, signal)(
            command,
            commandArgs,
            options,
          )
        },
      }),
    )
  }
  const extensionHost: ExtensionHost = {
    invoke: async (name, action, args, signal, conversationId) => {
      if (userActions.get(name)?.includes(action))
        throw new Error(`${name}/${action} is a user-only action`)
      return invoke(name, action, args, signal, conversationId, 'agent')
    },
    emit: log.emit,
    react: () => {
      throw new Error('Reactors require a facet scope')
    },
    eventLog: log.eventLog,
    implement: () => {
      throw new Error('Providers require a facet scope')
    },
    need: () => {
      throw new Error('Consumers require a facet scope')
    },
    want: () => {
      throw new Error('Consumers require a facet scope')
    },
    catalogue: () => apis.catalogue(),
    trace: trace.reader,
    access: runtime.access,
    notice,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: (callback) => {
      if (closed) return
      processOpeners.add(callback)
      if (open)
        // oxlint-disable-next-line typescript/no-floating-promises -- lifecycle runners report callback failures.
        void runProcessOpeners(activation)
    },
    onReady: (callback) => {
      if (closed) return
      processReadies.add(callback)
      if (ready)
        // oxlint-disable-next-line typescript/no-floating-promises -- lifecycle runners report callback failures.
        void runProcessReadies(activation)
    },
    channelHost: runtime.channelHost,
    webChannel: () => {
      throw new Error('The web channel requires a facet scope')
    },
    onRelease: (callback) => {
      releasers.add(callback)
    },
    onClose: (cleanup) => cleanups.add(cleanup),
    onLoadError: (callback) => loadErrorListeners.add(callback),
    onBeforeLoad: (callback) => beforeLoad.add(callback),
    ultimateRoot: host.ultimateRoot,
    projectAccess: host.projectAccess,
    projectRoot: host.projectRoot,
    userHome: host.userHome,
    home: host.home,
    modelRuntime: host.modelRuntime,
    settings: host.settings,
    build: host.build,
    uiState: (caller) => host.uiState(caller),
    scanSubmissions: (query, limit, cursor, caller) =>
      host.scanSubmissions(query, limit, cursor, caller),
    models: () => host.models(),
    skills: (cwd) => projectSkills(host, cwd, info()).skills,
    restart: async (approved) => (await prepared()) ?? host.restart(approved),
    get chapter() {
      return host.chapter
    },
    harness: runtime.harness,
    system: runtime.system,
    watchWebEndpoint: runtime.watchWebEndpoint,
    conversations: runtime.conversations,
    projects: () => projects(host.userHome, host.home),
    extensions: () => info(),
    projectSetup: () => projectSetup(host.projectRoot, host.userHome, host.projectAccess),
    projectSettings: () =>
      projectSettings(host.projectRoot, host.userHome, notice, host.projectAccess),
    projectExtensions: async () => {
      const available = await discoverExtensions(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        true,
        undefined,
        host.projectAccess,
      )
      return available
        .filter((entry) => entry.source === 'project')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          source: entry.source,
          enabled: records.get(entry.name)?.path === entry.path && records.get(entry.name)!.enabled,
          layer: available.settings.layers.get(entry.name) ?? 'folder',
          actions: [],
          events: [],
          facets: {
            server: entry.files.includes('server.ts'),
            web: entry.files.includes('web.tsx'),
          },
          ...(existsSync(join(host.ultimateRoot, 'extensions', entry.name))
            ? { replaces: 'builtin' as const }
            : {}),
        }))
    },
    setProjectDecision: async (local) => {
      host.projectAccess.setDecision(local)
      await extensionHost.reloadExtensions()
    },
    reloadExtensions: async () => {
      const work = chain
        .then(() => (closed ? undefined : preparedToLoad()))
        .then(() => (closed ? undefined : reloadSettings()))
      // The caller gets the failure; the chain recovers so later reloads still run.
      chain = work.catch(() => changed())
      await work
      await rebuildWeb()
    },
    doc: findDoc,
    metadata: Metadata,
  }
  const installed = host.extensionOrders
  const info = () =>
    [...records.values()].toSorted((a, b) =>
      compareExtensions(
        { ...a, order: installed.get(a.name) },
        { ...b, order: installed.get(b.name) },
      ),
    )
  let chain = Promise.resolve()
  /** Runs `work` after earlier reloads; a failure becomes a notice and still publishes what is loaded. */
  function enqueue(work: () => Promise<void>) {
    chain = chain
      .then(() => (closed ? undefined : preparedToLoad()))
      .then(() => (closed ? undefined : work()))
      .catch((error: unknown) => {
        notice(`Extension reload failed: ${String(error)}`)
        return changed()
      })
  }
  /** Drops `name`'s server facet: its host, tools, documents and actions. */
  async function unload(name: string) {
    await dispose(facetHosts.get(name))
    facetHosts.delete(name)
    if (installed.delete(name)) host.registry.uninstall({ name })
    documents.delete(name)
    actions.delete(name)
    userActions.delete(name)
    pollActions.delete(name)
    settingsReloads.delete(name)
  }
  const settingsFiles = [
    ...extensionSettingsFiles(host.projectRoot, host.userHome),
    join(host.userHome, '.ultimate/trust.json'),
  ]
  let previousSettings: string | undefined
  let diagnostics: string[] = []
  async function discover() {
    const active = await discoverExtensions(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      false,
      undefined,
      host.projectAccess,
    )
    const available = await discoverExtensions(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      true,
      active.settings,
      host.projectAccess,
    )
    const winners = [
      ...active,
      ...available
        .filter((entry) => !active.some((current) => current.name === entry.name))
        .map((entry) => ({ ...entry, enabled: false })),
    ].toSorted(compareExtensions)
    return Object.assign(winners, { settings: active.settings })
  }
  async function reload(
    selected?: Set<string>,
    servers = selected,
    winners?: Awaited<ReturnType<typeof discover>>,
  ) {
    winners ??= await discover()
    const folders = winners.map((winner) => winner.name)
    const settings = winners.settings
    diagnostics = [
      ...settings.notices,
      ...host.projectAccess.diagnostics(),
      ...[...settings.overrides.keys()]
        .filter((name) => !folders.includes(name))
        .map((name) => `Unknown extension: ${name}`),
      ...winners
        .filter((winner) => winner.core && settings.overrides.get(winner.name) === false)
        .map((winner) => `${winner.name} is core and stays enabled; extensions.disable ignores it`),
    ]
    const signature = JSON.stringify([settings.contents, folders, diagnostics])
    if (signature !== previousSettings) {
      for (const message of diagnostics) notice(message)
      previousSettings = signature
    }
    for (const {
      name,
      path,
      target,
      source,
      enabled,
      files,
      core,
      error: discoveryError,
    } of winners) {
      if (closed) return
      const previous = records.get(name)
      host.extensionSources.set(name, source)
      const layer = settings.layers.get(name) ?? (source === 'builtin' ? 'default' : 'folder')
      if (selected && !selected.has(name) && previous) {
        if (previous) previous.layer = layer
        continue
      }
      let readme: string | undefined
      if (files.includes('README.md'))
        readme = (await readFile(join(path, 'README.md'), 'utf8')).trim().split(/\n\s*\n/)[0]
      const record: ExtensionInfo = {
        name,
        path,
        source,
        enabled,
        ...(core ? { core } : {}),
        layer,
        actions: Object.keys(actions.get(name) ?? {}),
        events: (await contractOutline({ name, path, enabled })).events,
        readme,
        facets: { server: files.includes('server.ts'), web: files.includes('web.tsx') },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (enabled && record.facets.server && (!servers || servers.has(name))) {
        const facetHost = scope(name)
        try {
          // Vite keeps a URL bound to the file it first resolved to, so a repointed link loads by its target.
          const module = await vite.ssrLoadModule(join(target, 'server.ts'))
          const extension: Extension =
            typeof module.default === 'function' ? await module.default(facetHost) : module.default
          if (!extension || extension.name !== name)
            throw new Error('Extension name must match its folder')
          const docs: ConversationDocToken<JsonObject>[] = module.docs ?? []
          if (!Array.isArray(docs) || docs.some((doc) => doc.definition.scope !== 'conversation'))
            throw new Error('docs must contain conversation document tokens')
          const exportedActions: Record<string, ExtensionAction> = module.actions ?? {}
          if (Object.values(exportedActions).some((action) => typeof action !== 'function'))
            throw new Error('actions must contain functions')
          const exportedUserActions: unknown = module.userActions ?? []
          if (
            !Array.isArray(exportedUserActions) ||
            exportedUserActions.some(
              (action) => typeof action !== 'string' || !Object.hasOwn(exportedActions, action),
            )
          )
            throw new Error('userActions must contain registered action names')
          const exportedPollActions: unknown = module.pollActions ?? []
          if (
            !Array.isArray(exportedPollActions) ||
            exportedPollActions.some(
              (action) => typeof action !== 'string' || !Object.hasOwn(exportedActions, action),
            )
          )
            throw new Error('pollActions must contain registered action names')
          // A function derives them from the facet's config; it runs again on each reload.
          const secrets = validateSecrets(
            typeof module.secrets === 'function'
              ? await module.secrets(facetHost)
              : (module.secrets ?? []),
          )
          // Pi lets the last extension win a tool name silently. A later source layer overriding a tool on purpose is
          // fine (a project's bash over coding-tools); within one layer, the extension holding the name keeps it.
          const taken = host.registry
            .snapshot()
            .tools()
            .filter(
              (entry) =>
                entry.extension.name !== name &&
                host.extensionSources.get(entry.extension.name) === source &&
                extension.tools?.some((tool) => tool.name === entry.tool.name),
            )
            .map((entry) => `${entry.tool.name} is already provided by ${entry.extension.name}`)
          if (taken.length) throw new Error(taken.join('; '))
          host.registry.install(trace.tools(extension))
          const previousHost = facetHosts.get(name)
          facetHosts.set(name, facetHost)
          for (const [key, value] of provided.get(facetHost)!)
            providers.set(key, { owner: facetHost, value })
          await dispose(previousHost)
          actions.set(name, exportedActions)
          userActions.set(name, exportedUserActions)
          pollActions.set(name, exportedPollActions)
          if (module.reloadOnSettings === true) settingsReloads.add(name)
          else settingsReloads.delete(name)
          record.actions = Object.keys(exportedActions)
          installed.set(name, module.order ?? 0)
          documents.set(name, docs)
          record.server = {
            loadedAt: new Date().toISOString(),
            tools:
              extension.tools?.map((tool) => ({
                name: tool.name,
                description: tool.description.trim().split('\n')[0] ?? '',
              })) ?? [],
            sections: extension.sections?.map((section) => section.key) ?? [],
            hooks: extension.hooks?.length ?? 0,
            docs: docs.map((doc) => doc.definition.kind),
            secrets,
          }
          if (open) {
            openState(facetHost, activation)
            await runFacetOpeners(facetHost, activation)
            if (ready) await runFacetReadies(facetHost, activation)
          }
        } catch (error) {
          await dispose(facetHost)
          record.server = {
            ...(previous?.server ?? { tools: [], sections: [], hooks: 0, docs: [] }),
            error: String(error),
          }
          for (const listener of loadErrorListeners) listener(name, String(error))
        }
      } else if (!enabled || !record.facets.server) {
        await unload(name)
        record.actions = []
        delete record.server
      }
      if (enabled && discoveryError)
        record.server = { tools: [], sections: [], hooks: 0, docs: [], error: discoveryError }
      if (enabled && !record.server?.error) host.builds.extension(name, path)
      if (!enabled) host.builds.remove(name)
      records.set(name, record)
      targets.set(name, target)
    }
    for (const name of records.keys()) {
      if (!folders.includes(name)) {
        await unload(name)
        records.delete(name)
        targets.delete(name)
        host.extensionSources.delete(name)
        host.builds.remove(name)
      }
    }
    host.builds.refresh(winners.map(({ name, enabled }) => [name, enabled]))
    const missing = new Set(apis.missing())
    for (const message of missing) if (!missingApis.has(message)) notice(message)
    missingApis = missing
    await changed()
  }
  async function reloadSettings() {
    const winners = await discover()
    await reload(
      new Set(
        winners
          .filter((entry) => {
            const previous = records.get(entry.name)
            return (
              !previous ||
              previous.enabled !== entry.enabled ||
              previous.path !== entry.path ||
              targets.get(entry.name) !== entry.target ||
              settingsReloads.has(entry.name)
            )
          })
          .map((entry) => entry.name),
      ),
      undefined,
      winners,
    )
  }
  await reload()
  // A restarted Vite starts with an empty module graph, so the next change reloads every extension.
  let graphLost = false
  // Vite owns the transitive local module graph; query-string imports do not.
  const onChange = (file: string) => {
    if (
      closed ||
      ![host.ultimateRoot, host.projectRoot, ...roots.slice(1).map((root) => root.path)].some(
        (root) => resolve(file).startsWith(root + '/'),
      ) ||
      file.includes('/node_modules/')
    )
      return
    if (settingsFiles.includes(resolve(file))) {
      enqueue(reloadSettings)
      return
    }
    const directory = directories.find((root) => file.startsWith(root + '/'))
    if (!directory && !/\.[cm]?[jt]s$/.test(file)) return
    if (directory && inExtensionTests(file.slice(directory.length + 1))) return
    if (graphLost) {
      graphLost = false
      enqueue(() => reload())
      return
    }
    enqueue(async () => {
      try {
        const selected = new Set<string>()
        // Vite keys its graph by real path, while the watcher reports a symlinked extension's files through the
        // link. A file removed since the event has no real path; its link path then misses the graph, as before.
        const modules = vite.moduleGraph.getModulesByFile(await realpath(file).catch(() => file))
        const visited = new Set<import('vite-plus').ModuleNode>()
        const visit = (module: import('vite-plus').ModuleNode) => {
          if (visited.has(module)) return
          visited.add(module)
          for (const name of records.keys())
            if (module.file === join(targets.get(name)!, 'server.ts')) selected.add(name)
          for (const importer of module.importers) visit(importer)
        }
        for (const module of modules ?? []) visit(module)
        for (const module of visited) vite.moduleGraph.invalidateModule(module)
        const name = directory ? file.slice(directory.length + 1).split('/')[0] : undefined
        const servers = new Set(selected)
        if (name) {
          selected.add(name)
          if (directory && file === join(directory, name, 'server.ts')) servers.add(name)
        }
        await reload(selected, servers)
      } catch (error) {
        for (const record of records.values())
          if (record.server) record.server.error = String(error)
        throw error
      }
    })
  }
  const onStructure = (file: string) => {
    const directory = directories.find((root) => file.startsWith(root + '/'))
    if (!directory) return onChange(file)
    if (inExtensionTests(file.slice(directory.length + 1))) return
    if (graphLost) {
      graphLost = false
      enqueue(() => reload())
      return
    }
    const name = file.slice(directory.length + 1).split('/')[0]
    enqueue(() => reload(new Set([name]), new Set([name])))
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  // Vite's watcher follows links and reports a linked extension as gone once its target is; discovery then keeps the
  // dangling link as a record with its error. Removing that link later is an event only the extensions folder itself
  // sees, so each folder is also watched directly for a recorded entry that left (#561727).
  const watchEntries = (directory: string) => {
    try {
      return watchDirectory(directory, (_event, name) => {
        if (closed || !name || records.get(name)?.path !== join(directory, name)) return
        if (lstatSync(join(directory, name), { throwIfNoEntry: false })) return
        enqueue(() => reload(new Set([name])))
      })
    } catch (error) {
      // A missing folder has no entries; watchRoots reports it once it appears.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }
  let attached = false
  const unwatch = watch((watcher) => {
    graphLost = attached
    attached = true
    const watchedRoots = [
      ...directories,
      ...settingsFiles,
      ...roots.slice(1).map((root) => join(root.path, 'skills')),
    ]
    watcher.add(watchedRoots)
    const entries = new Map(directories.map((directory) => [directory, watchEntries(directory)]))
    const stopRoots = watchRoots(watchedRoots, (root) => {
      watcher.add(root)
      if (entries.has(root)) {
        entries.get(root)?.close()
        entries.set(root, watchEntries(root))
      }
      enqueue(() => (settingsFiles.includes(root) ? reloadSettings() : reload()))
    })
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      stopRoots()
      for (const entry of entries.values()) entry?.close()
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })
  return {
    info: Object.assign(info, {
      diagnostics: async () => {
        const notices = [...facetNotices.values()].flatMap((messages) => [...messages])
        const stored = notices.some(([, item]) => item.untilSecretSet)
          ? await secretMetadata(host.userHome).catch(() => [])
          : []
        const names = new Set(stored.map(({ name }) => name))
        return [
          ...new Set([
            ...diagnostics,
            ...notices.flatMap(([message, item]) =>
              item.untilSecretSet && names.has(item.untilSecretSet) ? [] : [message],
            ),
            ...apis.missing(),
            ...host.projectAccess.diagnostics(),
          ]),
        ]
      },
    }),
    action(name: string, action: string) {
      const table = actions.get(name)
      return table && Object.hasOwn(table, action) ? table[action] : undefined
    },
    invoke,
    doc: findDoc,
    catalogue: () => apis.catalogue(),
    sourceStatusProvider: () =>
      providers.get(SourceStatusApi.name)?.value as (typeof SourceStatusApi)['service'],
    // Use the existing provider table; a public conversation operation takes a fresh view after facet reloads.
    configurationServices(this: void): ConfigurationServices {
      const persona = providers.get(PersonaApplication.name)
        ?.value as ConfigurationServices['persona']
      const conversations = providers.get('conversations')?.value as
        | { setAutomaticSummaries: ConfigurationServices['summaries'] }
        | undefined
      return { persona, summaries: conversations?.setAutomaticSummaries }
    },
    trace: trace.reader,
    prepared,
    preparedToLoad,
    /** The harness is open: run the `onOpen` callbacks. */
    async opened() {
      if (closed) throw new Error('Extensions are closed')
      trace.open()
      open = true
      ready = false
      activation++
      const generation = activation
      processOpenState = undefined
      processReadyState = undefined
      for (const [name, facetHost] of facetHosts) {
        openState(facetHost, generation)
        for (const [message, item] of facetNotices.get(facetHost) ?? [])
          if (!item.recorded) {
            log.notice(name, message)
            item.recorded = true
          }
      }
      await Promise.all([
        ...[...facetHosts.values()].map((facetHost) => runFacetOpeners(facetHost, generation)),
        runProcessOpeners(generation),
      ])
    },
    /** Open public readiness after the backend is admitted; callbacks may use its mutation port. */
    async ready() {
      if (closed || !open) throw new Error('Harness is not open')
      ready = true
      const generation = activation
      await Promise.all([
        ...[...facetHosts.values()].map((facetHost) => runFacetReadies(facetHost, generation)),
        runProcessReadies(generation),
      ])
    },
    /** The harness is about to close: run the `onRelease` callbacks. */
    async released() {
      ready = false
      open = false
      activation++
      const pending = [
        ...[...facetOpenStates.values()].map((state) => state.running),
        ...[...facetReadyStates.values()].map((state) => state.running),
        processOpenState?.running,
        processReadyState?.running,
      ].filter((task): task is Promise<void> => task !== undefined)
      await Promise.all(pending)
      await Promise.all([...releasers].map(runReleaser))
      trace.close()
    },
    async close() {
      closed = true
      ready = false
      open = false
      activation++
      unwatch()
      await chain
      const pending = [
        ...[...facetOpenStates.values()].map((state) => state.running),
        ...[...facetReadyStates.values()].map((state) => state.running),
        processOpenState?.running,
        processReadyState?.running,
      ].filter((task): task is Promise<void> => task !== undefined)
      await Promise.all(pending)
      for (const facetHost of subscriptions.keys()) await dispose(facetHost)
      const results = await Promise.allSettled([...cleanups].map(async (cleanup) => cleanup()))
      for (const result of results)
        if (result.status === 'rejected')
          notice(`Process resource cleanup failed: ${String(result.reason)}`)
      trace.close()
    },
  }
}
export function validateSecrets(
  value: unknown,
): NonNullable<NonNullable<ExtensionInfo['server']>['secrets']> {
  if (!Array.isArray(value)) throw new Error('secrets must be an array of declarations')
  return value.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(item.name) ||
      typeof item.description !== 'string' ||
      !item.description.trim()
    )
      throw new Error('secrets require an uppercase name and non-empty description')
    if (item.url !== undefined) {
      try {
        if (
          typeof item.url !== 'string' ||
          !['http:', 'https:'].includes(new URL(item.url).protocol)
        )
          throw new Error()
      } catch {
        throw new Error('secret URLs must use http(s)')
      }
    }
    if (item.provider !== undefined && (typeof item.provider !== 'string' || !item.provider))
      throw new Error('secret providers must be non-empty strings')
    return {
      name: item.name,
      description: item.description,
      ...(item.url === undefined ? {} : { url: item.url }),
      ...(item.provider === undefined ? {} : { provider: item.provider }),
    }
  })
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import type { ViteDevServer } from 'vite-plus'
import { Events } from './web-channel.ts'
import type { WebChannelRuntime } from './web-channel.ts'
import { createConversationHost } from './conversation-host.ts'
import type { ConversationBackend } from './conversation-host.ts'
import { loadExtensions } from './extensions.ts'
import type { Watch } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions, OpenHost } from './harness.ts'
import { createSystem } from './system.ts'
import { emit } from './events.ts'
import { StartedEvent } from '../shared/events.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ChildMessage, SupervisorMessage } from './supervisor-protocol.ts'

import { alive } from './lock.ts'
import { realpath } from 'node:fs/promises'
import { extensionModules } from './vite-extensions.ts'
import { createAccess } from './request-security.ts'
import { reportCore } from './supervisor-protocol.ts'
import { viteLogger } from './vite-logger.ts'
import type { Notice, SystemInfo } from '../shared/protocol.ts'
import { ChannelError } from '../shared/channel-host.ts'

const send = (message: ChildMessage) => process.send?.(message)

export interface ServerOptions extends HostOptions {
  /** The web channel's port; otherwise `ULTIMATE_PORT`, else 4747. The core itself listens on none. */
  port?: number
}
/** The web channel's first port, and whether it moves on past a taken one: only supervised with none requested. */
function webPort(requested: number | undefined) {
  const variable = process.env.ULTIMATE_PORT
  const first = requested ?? (variable === undefined ? 4747 : Number(variable))
  if (!Number.isInteger(first) || first < 0 || first > 65535) throw new Error('Invalid port')
  return {
    first,
    scan:
      requested === undefined && variable === undefined && process.env.ULTIMATE_SUPERVISED === '1',
  }
}
export async function prepareServer(options: Partial<ServerOptions> = {}) {
  const ultimateRoot =
    options.ultimateRoot ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
  const projectRoot = await realpath(
    options.projectRoot ?? process.env.ULTIMATE_PROJECT ?? options.ultimateRoot ?? process.cwd(),
  )
  const events = new Events()
  const notice = (entry: Notice) => {
    events.emit('notice', entry)
    reportCore({
      type: 'log',
      level: entry.level === 'warning' ? 'warn' : entry.level,
      source: 'core',
      text: entry.message,
    })
  }
  const host = await prepareHarness({
    ...options,
    ultimateRoot,
    projectRoot,
    report: notice,
  })
  let system: Awaited<ReturnType<typeof createSystem>> | undefined
  // Remote origins (Tailscale's HTTPS URL) usually register after startup and can go away: say each change once.
  let remote: string[] = []
  const access = createAccess(() => {
    const origins = access.origins()
    for (const origin of origins)
      if (!remote.includes(origin)) console.log(`Ultimate: ${origin} (remote)`)
    for (const origin of remote)
      if (!origins.includes(origin)) console.log(`Ultimate: ${origin} (remote) is no longer served`)
    remote = origins
    // The supervisor's dashboard keeps the current ones on screen; the log lines above are the history.
    reportCore({ type: 'access', origins })
    void system
      ?.changed()
      .catch((error: unknown) => console.error('Publishing access changes failed:', error))
  })
  let backend: ConversationBackend | undefined
  let releaseRequested = false
  let pendingReleases = 0
  let finalClosing = false
  let finalClose: Promise<void> | undefined
  let endpoint: string | undefined
  let bundle: { info(): SystemInfo['web']; rebuild(): Promise<void> } | undefined
  // A vite.config.ts change restarts Vite with a new watcher; listeners move to each new one.
  const restarted = new Set<(watcher: ViteDevServer['watcher']) => void>()
  // Vite only loads the server facets (`ssrLoadModule`) and watches the sources: the web channel builds the browser's
  // production bundle itself. Vite serves no page, holds no socket and optimizes no browser dependencies.
  const vite = await createViteServer({
    customLogger: viteLogger(),
    clearScreen: false,
    configFile: resolvePath(ultimateRoot, 'vite.config.ts'),
    root: ultimateRoot,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: resolvePath(host.home, 'vite'),
    resolve: { alias: { '@': resolvePath(ultimateRoot, 'web/src') } },
    plugins: [
      // Server facets outside the Ultimate root resolve its packages through it.
      extensionModules(ultimateRoot, projectRoot, host.userHome, undefined, host.projectAccess),
      {
        name: 'ultimate:watchers',
        configureServer: (server) => {
          for (const move of restarted) move(server.watcher)
        },
      },
    ],
  })
  // Without HMR Vite does not restart itself for a config change: a new config means a new module graph and watcher.
  const onConfig = (file: string) => {
    if (file === vite.config.configFile)
      vite.restart().catch((error: unknown) => console.error('Restarting Vite failed:', error))
  }
  const watch: Watch = (attach) => {
    let detach = attach(vite.watcher)
    const move = (watcher: ViteDevServer['watcher']) => {
      detach()
      detach = attach(watcher)
    }
    restarted.add(move)
    return () => {
      restarted.delete(move)
      detach()
    }
  }
  watch((watcher) => {
    watcher.on('change', onConfig)
    return () => watcher.off('change', onConfig)
  })
  let opened: OpenHost | undefined
  const processInfo: { activationError?: string } = {}
  // go and release each finish before the next starts.
  let switching = Promise.resolve()
  const serial = <T>(task: () => Promise<T>) => {
    const next = switching.then(task)
    // The caller gets the failure; the queue only waits for the task to settle.
    switching = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const port = webPort(options.port)
  let extensions: Awaited<ReturnType<typeof loadExtensions>> | undefined
  const webChannel: WebChannelRuntime = {
    events,
    extensions: () => {
      if (!extensions) throw new Error('Extensions are still loading')
      return extensions
    },
    access,
    watch,
    backend: () => {
      if (!backend) throw new ChannelError('unavailable', 'Conversation service is unavailable')
      return backend
    },
    port,
    endpoint(url) {
      if (url === endpoint) return
      endpoint = url
      reportCore(url ? { type: 'web', state: 'ready', url } : { type: 'web', state: 'stopped' })
      void system
        ?.changed()
        .catch((error: unknown) => console.error('Publishing the web endpoint failed:', error))
    },
    bundle(value) {
      bundle = value
      void system
        ?.changed()
        .catch((error: unknown) => console.error('Publishing the web bundle failed:', error))
    },
  }
  extensions = await loadExtensions(
    vite,
    host,
    () => system?.changed(),
    {
      access,
      harness: () => {
        if (!opened) throw new Error('Harness is not open')
        return opened.harness
      },
      system: () => {
        if (!system) throw new Error('System is not ready')
        return system.current()
      },
      conversations: () => backend?.conversations() ?? [],
      channelHost: () => {
        if (!backend) throw new ChannelError('unavailable', 'Conversation service is unavailable')
        return backend.channelHost
      },
      webChannel: () => webChannel,
      watchWebEndpoint(callback) {
        let previous = endpoint
        const listener = (name: string) => {
          if (name !== 'system' || previous === endpoint) return
          previous = endpoint
          callback(endpoint)
        }
        events.listeners.add(listener)
        return () => events.listeners.delete(listener)
      },
    },
    watch,
    (message) => notice({ level: 'warning', message }),
    () => bundle?.rebuild() ?? Promise.resolve(),
  )
  const loaded = extensions
  system = await createSystem(
    host,
    watch,
    () => endpoint,
    loaded.info,
    (info) => events.emit('system', info),
    (message) => notice({ level: 'error', message }),
    processInfo,
    access.origins,
    () => bundle?.info() ?? { id: '', changed: [] },
    loaded.sourceStatusProvider,
  )
  const ready = system
  /** Serve the opened harness: shared backend, facet openers, resume, then readiness. */
  const serve = async (harness: OpenHost) => {
    opened = harness
    let service: ConversationBackend | undefined
    let callbacksOpened = false
    try {
      await harness.harness.commit(
        (tx) =>
          emit(tx, StartedEvent, {
            generation: Number(process.env.ULTIMATE_GENERATION ?? 1),
            build: host.build().id,
          }),
        context,
      )
      service = await createConversationHost(host, harness, {
        configurationServices: loaded.configurationServices,
        extensions: loaded.info,
        onConversations: (summaries) => events.emit('conversations', summaries),
        onTasks: (tasks) => events.emit('tasks', tasks),
        onRefreshError: () =>
          events.emit('notice', { level: 'error', message: 'Could not refresh conversation list' }),
      })
      backend = service
      await loaded.opened()
      callbacksOpened = true
      await ready.changed()
      harness.harness.resume()
      if (releaseRequested || finalClosing) service.closeAdmission()
      else {
        service.openAdmission()
        await loaded.ready()
      }
      return { ...harness, system: ready }
    } catch (error) {
      service?.closeAdmission()
      if (callbacksOpened) await loaded.released()
      try {
        await service?.close()
      } catch (cleanupError) {
        console.error('Closing conversation backend after activation failure:', cleanupError)
      }
      if (backend === service) backend = undefined
      if (opened === harness) opened = undefined
      await harness.close()
      throw error
    }
  }
  return {
    vite,
    host,
    extensions: loaded,
    events,
    /** The web channel's URL, while one listens. */
    get url() {
      return endpoint
    },
    get port() {
      return endpoint === undefined ? undefined : Number(new URL(endpoint).port)
    },
    /** Summaries of every conversation, as the conversation list shows them; empty while storage is closed. */
    conversations: () => backend?.conversations() ?? [],
    release() {
      releaseRequested = true
      pendingReleases++
      backend?.closeAdmission()
      return serial(async () => {
        try {
          // The web channel stops listening here, in its release callback.
          if (opened) await loaded.released()
          // Admitted requests settle first, so an in-flight mutation that lost the race still gets its 503.
          await backend?.close()
          backend = undefined
          await opened?.close()
          opened = undefined
        } finally {
          pendingReleases--
          if (pendingReleases === 0) releaseRequested = false
        }
      })
    },
    /** Open storage and serve. */
    go(activationError?: string) {
      return serial(async () => {
        if (finalClosing) throw new Error('Server is closing')
        releaseRequested = false
        processInfo.activationError = activationError
        return serve(await host.open(false))
      })
    },
    close() {
      if (finalClose) return finalClose
      finalClosing = true
      releaseRequested = true
      backend?.closeAdmission()
      finalClose = serial(async () => {
        // Release, then close the Harness before the extensions: work still running against a disposed service would
        // fail, while work left in the closed Harness stays pending and resumes on the next open.
        if (opened) await loaded.released()
        await backend?.close()
        backend = undefined
        await opened?.close()
        opened = undefined
        await loaded.close()
        await ready.close()
        await vite.close()
      })
      return finalClose
    },
  }
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const prepared = await prepareServer(options)
  const opened = await prepared.go()
  // Assigned, not spread: `url` and `port` stay live as the web channel binds and releases.
  const close = prepared.close.bind(prepared)
  return Object.assign(prepared, opened, { close })
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.ULTIMATE_INSTANCE_OWNER) {
    const owner = Number(process.env.ULTIMATE_INSTANCE_OWNER)
    if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Invalid instance owner')
    setInterval(() => {
      if (!alive(owner)) process.exit(0)
    }, 500).unref()
  }
  let server: Awaited<ReturnType<typeof prepareServer>> | undefined
  let closing: Promise<void> | undefined
  // Every caller waits for the one close: under systemd the child gets SIGTERM and then the supervisor's `exit`, and
  // exiting on the second while the first still tears down (the Tailscale mapping) would cut it short.
  const close = () => (closing ??= Promise.resolve(server?.close()))
  const shutdown = () => {
    void close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Server shutdown failed:', error)
        process.exit(1)
      },
    )
  }
  if (process.env.ULTIMATE_SUPERVISED === '1' && process.send) {
    const refuse = (signal: NodeJS.Signals) =>
      reportCore({
        type: 'log',
        level: 'warn',
        source: 'core',
        text: `Ignored ${signal} sent to core pid ${process.pid}: the supervisor stops its core itself. Either Ultimate is stopping through its service (the signal went to the whole group), or a process outside it killed by port or name`,
      })
    process.on('SIGINT', refuse)
    process.on('SIGTERM', refuse)
    try {
      server = await prepareServer()
      process.on('message', (message: SupervisorMessage) => {
        void (async () => {
          if (message.type === 'go' || message.type === 'reacquire') {
            await server!.go(message.type === 'reacquire' ? message.error : undefined)
            send({ type: 'ready' })
          }
          if (message.type === 'release') {
            await server!.release()
            send({ type: 'released' })
          }
          if (message.type === 'exit') {
            await close()
            process.exit(0)
          }
        })().catch((error) => {
          send({ type: 'failed', error: String(error) })
          console.error(error)
          process.exit(1)
        })
      })
      process.on('disconnect', shutdown)
      send({ type: 'prepared' })
    } catch (error) {
      send({ type: 'failed', error: String(error) })
      console.error(error)
      process.exit(1)
    }
  } else {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    server = await prepareServer()
    await server.go()
    // Previews read this line for the URL.
    console.log(server.url ? `Ultimate: ${server.url}` : 'Ultimate: ready without a web endpoint')
  }
}

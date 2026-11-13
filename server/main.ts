import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import type { ViteDevServer } from 'vite-plus'
import { createApi, Events } from './api.ts'
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
import { createWeb } from './web.ts'
import { admit, createAccess } from './request-security.ts'
import { writeProject } from './project.ts'
import { reportCore } from './supervisor-protocol.ts'
import { viteLogger } from './vite-logger.ts'
import type { Notice } from '../shared/protocol.ts'
import { ChannelError } from '../shared/channel-host.ts'

const send = (message: ChildMessage) => process.send?.(message)

/**
 * Clickjacking: a foreign page must not load the UI in a hidden frame and steer clicks into it (PR #74, #517728).
 * Loopback parents stay allowed: a preview frames another instance on its own port (`extensions/instance/web.tsx`),
 * and the supervisor's app window is `ultimate.localhost`. No `[::1]` entry: CSP rejects a port range on an IPv6
 * literal, and one bad source makes browsers drop the whole directive.
 */
const frameAncestors =
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:*"

export interface ServerOptions extends HostOptions {
  port?: number
  publicUrl?: string
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
  let api: Awaited<ReturnType<typeof createApi>> | undefined
  let backend: ConversationBackend | undefined
  let web: Awaited<ReturnType<typeof createWeb>> | undefined
  let releaseRequested = false
  let pendingReleases = 0
  let finalClosing = false
  let finalClose: Promise<void> | undefined
  const http = createHttpServer((request, response) => {
    void (async () => {
      const port =
        new URL(
          options.publicUrl ??
            `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`,
        ).port || '80'
      if (!(await admit(request, port, access.rules))) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      if (!api) {
        response.writeHead(503)
        response.end('Preparing')
        return
      }
      response.setHeader('Content-Security-Policy', frameAncestors)
      if (await api.handle(request, response)) return
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      await web!.handle(request, response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Internal server error')
    })
  })
  // A vite.config.ts change restarts Vite with a new watcher; listeners move to each new one.
  const restarted = new Set<(watcher: ViteDevServer['watcher']) => void>()
  reportCore({ type: 'web', state: 'preparing' })
  // Vite only loads the server facets (`ssrLoadModule`) and watches the sources: the browser gets a production bundle
  // (web.ts). It serves no page, holds no client socket and optimizes no browser dependencies.
  const vite = await createViteServer({
    customLogger: viteLogger(),
    clearScreen: false,
    configFile: resolvePath(ultimateRoot, 'vite.config.ts'),
    root: resolvePath(ultimateRoot, 'web'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: resolvePath(host.home, 'vite'),
    resolve: { alias: { '@': resolvePath(ultimateRoot, 'web/src') } },
    plugins: [
      // Server facets outside the Ultimate root resolve its packages through it.
      extensionModules(ultimateRoot, projectRoot, host.userHome),
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
  const extensions = await loadExtensions(
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
    },
    watch,
    (message) => notice({ level: 'warning', message }),
    () => web!.rebuild(),
  )
  web = await createWeb({
    ultimateRoot,
    projectRoot,
    userHome: host.userHome,
    home: host.home,
    watch,
    before: () => extensions.preparedToLoad(),
    pages: () => api?.pages() ?? 0,
    changed: () => void system?.changed(),
    notice: (message) => notice({ level: 'error', message }),
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? Number(process.env.ULTIMATE_PORT ?? 4747), '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  const url = options.publicUrl ?? `http://127.0.0.1:${address.port}`
  system = await createSystem(
    host,
    watch,
    url,
    extensions.info,
    (info) => events.emit('system', info),
    (message) => notice({ level: 'error', message }),
    processInfo,
    access.origins,
    () => web.info(),
  )
  /** Serve the opened harness: shared backend, facet openers, web adapter, resume, then readiness. */
  const serve = async (harness: OpenHost) => {
    opened = harness
    let service: ConversationBackend | undefined
    let adapter: Awaited<ReturnType<typeof createApi>> | undefined
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
        onConversations: (summaries) => events.emit('conversations', summaries),
        onTasks: (tasks) => events.emit('tasks', tasks),
        onRefreshError: () =>
          events.emit('notice', { level: 'error', message: 'Could not refresh conversation list' }),
      })
      backend = service
      await extensions.opened()
      callbacksOpened = true
      await system.changed()
      adapter = await createApi(host, harness, events, system, extensions, access, service)
      api = adapter
      harness.harness.resume()
      if (releaseRequested || finalClosing) service.closeAdmission()
      else {
        service.openAdmission()
        await extensions.ready()
      }
      return { ...harness, api: adapter, system }
    } catch (error) {
      service?.closeAdmission()
      if (api === adapter) api = undefined
      try {
        await adapter?.close()
      } catch (cleanupError) {
        console.error('Closing web adapter after activation failure:', cleanupError)
      }
      if (callbacksOpened) await extensions.released()
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
    http,
    vite,
    host,
    extensions,
    events,
    url,
    port: address.port,
    web,
    release() {
      releaseRequested = true
      pendingReleases++
      backend?.closeAdmission()
      const adapter = api
      api = undefined
      return serial(async () => {
        try {
          if (opened) await extensions.released()
          await (adapter ?? api)?.close()
          api = undefined
          // Admitted requests settle first, so an in-flight mutation that lost the race still gets its 503.
          await backend?.close()
          backend = undefined
          http.closeAllConnections()
          await opened?.close()
          opened = undefined
          reportCore({ type: 'web', state: 'stopped' })
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
        await writeProject(host.home, host.projectRoot)
        const served = await serve(await host.open(false))
        if (!releaseRequested && !finalClosing) reportCore({ type: 'web', state: 'ready' })
        return served
      })
    },
    close() {
      if (finalClose) return finalClose
      finalClosing = true
      releaseRequested = true
      backend?.closeAdmission()
      const adapter = api
      api = undefined
      const stopped = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      finalClose = serial(async () => {
        await (adapter ?? api)?.close()
        api = undefined
        await extensions.close()
        await backend?.close()
        backend = undefined
        await web?.close()
        await system?.close()
        await vite.close()
        reportCore({ type: 'web', state: 'stopped' })
        http.closeAllConnections()
        await stopped
        await opened?.close()
        opened = undefined
      })
      return finalClose
    },
  }
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const prepared = await prepareServer(options)
  const opened = await prepared.go()
  return { ...prepared, ...opened, close: () => prepared.close() }
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
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (process.env.ULTIMATE_SUPERVISED === '1' && process.send) {
    try {
      server = await prepareServer({ port: 0, publicUrl: process.env.ULTIMATE_PUBLIC_URL })
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
      send({ type: 'prepared', port: server.port })
    } catch (error) {
      send({ type: 'failed', error: String(error) })
      console.error(error)
      process.exit(1)
    }
  } else {
    server = await prepareServer()
    await server.go()
    console.log(`Ultimate: ${server.url}`)
  }
}

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- the web channel admits its requests with the core's access rules
import { admit } from '@ultimate/server/request-security.ts'
import { createWeb } from './bundle.ts'
import { createRoutes } from './routes.ts'

/**
 * Clickjacking: a foreign page must not load the UI in a hidden frame and steer clicks into it (PR #74, #517728).
 * Loopback parents stay allowed: a preview frames another instance on its own port (`extensions/instance/web.tsx`),
 * and the supervisor's app window is `ultimate.localhost`. No `[::1]` entry: CSP rejects a port range on an IPv6
 * literal, and one bad source makes browsers drop the whole directive.
 */
const frameAncestors =
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:*"

/** Listen on `first`, or with `scan` on the next free port after it; the bound port. */
async function listen(server: Server, first: number, scan: boolean) {
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      return (server.address() as AddressInfo).port
    } catch (error) {
      if (!scan || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port >= 65535)
        throw error
    }
  }
}

/** The listener of this process: it outlives a reload of the facet, which takes it over. */
type Shared = {
  /** The port this process bound: a re-enable and the next activation bind it again, so the URL stays. */
  port?: number
  listener?: { server: Server; port: number }
  /** The facet that serves the listener now, and its request handler. */
  owner?: Facet
  handle?: (request: IncomingMessage, response: ServerResponse) => void
}
type Facet = { disposed: boolean }

/**
 * The browser channel: its own HTTP listener on loopback, the browser API, the event stream and the bundle. It listens
 * while storage is open and stops on release, so the next core binds the same port; when off, nothing listens. A
 * reloaded facet takes the listener over, so a reload drops no connection.
 */
export default async function web(host: ExtensionHost) {
  const runtime = host.webChannel()
  const shared = host.resource('web.listener', (): Shared => ({}))
  const facet: Facet = { disposed: false }
  const previous = shared.owner
  let started = false
  let routes: ReturnType<typeof createRoutes> | undefined
  /** API requests a release waits for: admitted mutations settle, with their 503 when they lost the race. */
  const settling = new Set<Promise<void>>()
  let closing = false
  // Whether this facet publishes its bundle; a build that ends after the facet closed must not publish it again.
  let publishing = false
  const notice = (message: string) => {
    console.error(message)
    runtime.events.emit('notice', { level: 'error', message })
  }
  const bundle = await createWeb({
    ultimateRoot: host.ultimateRoot,
    projectRoot: host.projectRoot,
    projectAccess: host.projectAccess,
    userHome: host.userHome,
    home: host.home,
    watch: runtime.watch,
    before: () => runtime.extensions().preparedToLoad(),
    pages: () => routes?.pages() ?? 0,
    changed: () => {
      if (publishing) runtime.bundle(published)
    },
    notice,
  })
  const published = { info: () => bundle.info(), rebuild: () => bundle.rebuild() }
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const work: Promise<void> = (async () => {
      if (!(await admit(request, String(shared.listener?.port), runtime.access.rules))) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      const current = routes
      if (!current || closing) {
        response.writeHead(503)
        response.end('Preparing')
        return
      }
      response.setHeader('Content-Security-Policy', frameAncestors)
      if (await current.handle(request, response)) return
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      await bundle.handle(request, response)
    })()
      .catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end('Internal server error')
      })
      .finally(() => settling.delete(work))
    // Not waited for: pages and assets, extension actions, and a restart, which settles only when it fails. They end
    // when the connections close, as before the web channel had its own listener.
    if (/^\/api\/(?!extensions\/|restart$)/.test(request.url ?? '')) settling.add(work)
  }
  /** End this facet's streams and let its admitted requests settle; later requests get 503. */
  async function drain() {
    closing = true
    await routes?.close()
    while (settling.size) await Promise.allSettled(settling)
    routes = undefined
    closing = false
  }
  async function start() {
    started = true
    publishing = true
    runtime.bundle(published)
    if (shared.owner !== facet) return
    if (!shared.listener) {
      const server = createServer((request, response) => {
        if (shared.handle) shared.handle(request, response)
        else {
          response.writeHead(503)
          response.end('Preparing')
        }
      })
      const first = shared.port ?? runtime.port.first
      try {
        const port = await listen(server, first, shared.port === undefined && runtime.port.scan)
        shared.listener = { server, port }
        shared.port = port
      } catch (error) {
        // The runtime goes on without a browser; the notice says why.
        notice(`The web channel cannot listen on 127.0.0.1:${first}: ${String(error)}`)
        return
      }
    }
    routes = createRoutes(host, runtime, String(shared.listener.port))
    shared.handle = handle
    runtime.endpoint(`http://127.0.0.1:${shared.listener.port}`)
  }
  /** Release the port: on a release for the next core, and when the web channel is turned off or removed. */
  async function stop() {
    const current = shared.listener
    if (!current) return
    runtime.endpoint(undefined)
    await drain()
    const stopped = new Promise<void>((resolve) => current.server.close(() => resolve()))
    current.server.closeAllConnections()
    await stopped
    if (shared.listener === current) shared.listener = undefined
  }
  host.onOpen(start)
  host.onRelease(async () => {
    if (shared.owner === facet) await stop()
    else await drain()
  })
  host.onClose(async () => {
    facet.disposed = true
    if (shared.owner === facet) {
      // A facet that failed to load hands the listener back to the one that stays installed.
      if (!started && previous && !previous.disposed) shared.owner = previous
      else await stop()
    } else await drain()
    if (shared.handle === handle) shared.handle = undefined
    // Only what this facet published: a facet that failed to load leaves its predecessor's bundle in place.
    if (publishing) runtime.bundle(undefined)
    publishing = false
    await bundle.close()
  })
  // Last, after setup that can fail: from now on this facet serves the listener, and the one it replaces does not close it.
  shared.owner = facet
  return defineExtension({ name: 'web' })
}

/** The browser API: `/api/*` routes, the event stream, and the admission check of every request. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, DocumentWatch, EntryId, JsonObject } from '@earendil-works/pi-durable'
import type { ServerEvents } from '@ultimate/shared/protocol.ts'
import { UI_REVISION } from '@ultimate/shared/protocol.ts'
// oxlint-disable-next-line no-restricted-imports -- `/api/models` answers the core's model list
import { listModels } from '@ultimate/server/models.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import type { WebChannelRuntime } from '@ultimate/server/web-channel.ts'
// oxlint-disable-next-line no-restricted-imports -- `/api/ui` writes the core UI state document
import { UiState } from '@ultimate/server/ui-state.ts'
import type { JsonValue } from '@earendil-works/chord/json'
// oxlint-disable-next-line no-restricted-imports -- every request passes the core's admission check
import { admit, deviceOf } from '@ultimate/server/request-security.ts'
import { isChannelError } from '@ultimate/shared/channel-host.ts'
import type { CreateConversationRequest, SubmitRequest } from '@ultimate/shared/channel-host.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
async function body(
  request: IncomingMessage,
  limit = 1024 * 1024,
): Promise<Record<string, unknown>> {
  let data = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    data += chunk.toString()
    if (Buffer.byteLength(data) > limit) throw new HttpError(413, 'Request too large')
  }
  try {
    const value = JSON.parse(data || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new HttpError(400, 'Expected a JSON object')
  }
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Expected ${name}`)
  return value
}
const validUiKey = (key: unknown) =>
  typeof key === 'string' && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)
const actionPath = /^\/api\/extensions\/([^/]+)\/actions\/([^/]+)$/
const subscriptionPath = /^\/api\/events\/([0-9a-f-]+)\/(\d+)$/
/** One open `/api/events` stream: a browser tab's only long-lived request, carrying all its subscriptions. */
interface Connection {
  send: ReturnType<typeof eventStream>['send']
  subscriptions: Map<number, () => Promise<void>>
  /** Subscriptions closed before they were open, so an open that arrives after its close is not started. */
  closed: Set<number>
  ended: boolean
}
function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(data))
}
function failed(response: ServerResponse, error: unknown) {
  if (!response.headersSent) {
    const status =
      error instanceof HttpError
        ? error.status
        : isChannelError(error)
          ? {
              invalid_input: 400,
              not_found: 404,
              conflict: 409,
              unavailable: 503,
              internal: 500,
            }[error.code]
          : 500
    reply(response, status, {
      error: error instanceof HttpError || isChannelError(error) ? error.message : 'Request failed',
    })
  } else response.destroy()
}
/**
 * Start a server-sent event stream; `end` stops its heartbeat and closes it. An event of a subscription carries its id
 * on its first data line.
 */
function eventStream(response: ServerResponse) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write('retry: 500\n\n')
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(': heartbeat\n\n')
  }, 15000)
  return {
    send: (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents], sub?: number) => {
      if (!response.destroyed)
        response.write(
          `event: ${name}\n${sub === undefined ? '' : `data: ${sub}\n`}data: ${JSON.stringify(data)}\n\n`,
        )
    },
    end: () => {
      clearInterval(heartbeat)
      response.end()
    },
  }
}
/** `POST /api/extensions/:name/actions/:action`: answers `{ result }`, or the action's error message. */
async function runAction(
  request: IncomingMessage,
  response: ServerResponse,
  extensions: ReturnType<WebChannelRuntime['extensions']>,
  [, name, key]: RegExpExecArray,
  data: Record<string, unknown>,
) {
  if (request.headers['sec-fetch-site'] !== 'same-origin' && !request.headers.origin)
    throw new HttpError(403, 'Extension actions require a browser request')
  if (!extensions.action(name, key)) throw new HttpError(404, 'Unknown extension action')
  const id = data.conversationId
  if (id !== undefined && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1))
    throw new HttpError(400, 'Invalid conversation id')
  const controller = new AbortController()
  const cancel = () => {
    if (!response.writableEnded) controller.abort()
  }
  response.once('close', cancel)
  try {
    // Missing args mean none, so `curl -d '{}'` and agents can call argument-free actions.
    const args = (Object.hasOwn(data, 'args') ? data.args : {}) as JsonValue
    const result = await extensions.invoke(
      name,
      key,
      args,
      controller.signal,
      id,
      'ui',
      deviceOf(request.headers),
    )
    reply(response, 200, { result })
  } catch (error) {
    // An aborted action is the client leaving (a newer call, an unmount), not a fault.
    if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError')
      console.error(`Extension action ${name}/${key}:`, error)
    // The message is the action author's; the UI shows it, so a setup problem can say what is missing.
    const message = error instanceof Error ? error.message : String(error)
    reply(response, 500, { error: message.slice(0, 500) })
  } finally {
    response.off('close', cancel)
  }
}

/** Routes for the activation open now; `port` is the listener's, which loopback requests must name. */
export function createRoutes(host: ExtensionHost, runtime: WebChannelRuntime, port: string) {
  const harness = host.harness()
  const backend = runtime.backend()
  const extensions = runtime.extensions()
  const { access, events } = runtime
  const streams = new Set<() => Promise<void>>()
  const connections = new Map<string, Connection>()
  /** Open the tab's stream: its id, then the state every tab shares, then whatever it subscribes. */
  async function stream(request: IncomingMessage, response: ServerResponse) {
    const ui = await harness.watchDoc(UiState, ROOT_CONVERSATION_ID, context)
    const sse = eventStream(response)
    const id = crypto.randomUUID()
    const connection: Connection = {
      send: sse.send,
      subscriptions: new Map(),
      closed: new Set(),
      ended: false,
    }
    connections.set(id, connection)
    const { send } = sse
    send('stream', { id })
    send('system', host.system())
    send('conversations', backend.conversations())
    send('ui', { value: ui!.value })
    ui!.start(async (call) => {
      if (call.kind === 'value') send('uiOps', { ops: call.ops })
    })
    send('tasks', backend.taskGraph())
    events.listeners.add(send)
    const stop = async () => {
      if (connection.ended) return
      connection.ended = true
      connections.delete(id)
      events.listeners.delete(send)
      streams.delete(stop)
      await ui!.stop()
      await Promise.all([...connection.subscriptions.values()].map((close) => close()))
      sse.end()
    }
    streams.add(stop)
    response.on('close', () => {
      void stop().catch((error: unknown) => console.error('Stopping event stream failed:', error))
    })
    if (request.destroyed || response.destroyed) await stop()
  }
  /**
   * Stream a conversation's view (when `view`) and documents on `connection` as subscription `sub`: snapshots first,
   * then ops. Its id is the client's; an id is never reused, so its events never mix with a replaced subscription's.
   */
  async function subscribe(
    connection: Connection,
    sub: number,
    id: ConversationId,
    kinds: string[],
    withView: boolean,
  ) {
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new HttpError(404, 'Unknown conversation')
    const docs: { kind: string; watch: DocumentWatch<JsonObject> }[] = []
    const unknown: string[] = []
    const watches: { stop(): Promise<unknown> }[] = []
    const stop = async () => {
      await Promise.all(watches.map((watch) => watch.stop()))
    }
    let live: Awaited<ReturnType<typeof conversation.watch>> | undefined
    try {
      for (const kind of new Set(kinds)) {
        const token = extensions.doc(kind)
        if (!token) {
          unknown.push(kind)
          continue
        }
        await conversation.commit(async (tx) => {
          await tx.doc(token, id)
        }, context)
        const watch = await harness.watchDoc(token, id, context)
        if (watch) {
          docs.push({ kind, watch })
          watches.push(watch)
        }
      }
      if (withView) {
        // Pi's window: the newest 150 entries, growing to 300 before its oldest leave; `/history` pages the rest.
        live = await conversation.watch(context, { min: 150 })
        watches.push(live)
      }
    } catch (error) {
      await stop()
      throw error
    }
    // The stream ended, or the client closed or reused this id, while its watches opened.
    if (connection.ended || connection.closed.has(sub) || connection.subscriptions.has(sub)) {
      await stop()
      return
    }
    connection.subscriptions.set(sub, stop)
    const send = <K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) =>
      connection.send(name, data, sub)
    for (const kind of unknown)
      connection.send('notice', {
        level: 'warning',
        message: `Unknown extension document: ${kind}`,
      })
    if (live) {
      send('view', live.value)
      live.start(async (call) => {
        if (call.kind === 'value') send('ops', call.ops)
      })
    }
    for (const doc of docs) {
      send('doc', { kind: doc.kind, value: doc.watch.value })
      doc.watch.start(async (call) => {
        if (call.kind === 'value') send('docOps', { kind: doc.kind, ops: call.ops })
      })
    }
  }
  /** A conversation ID from a route; one that cannot exist is unknown, as before. */
  function routeId(value: string) {
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, 'Unknown conversation')
    return id
  }
  function conversationParam(value: unknown) {
    const id = value === undefined ? ROOT_CONVERSATION_ID : Number(value)
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Invalid conversation id')
    return id as ConversationId
  }
  return {
    /** Open browser tabs: each holds one event stream. */
    pages: () => connections.size,
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return false
      const json = (status: number, data: unknown) => reply(response, status, data)
      try {
        // Local-only does not mean safe from cross-origin browser requests.
        if (!(await admit(request, port, access.rules))) throw new HttpError(403, 'Forbidden')
        if (request.method === 'GET' && url.pathname === '/api/events') {
          await stream(request, response)
          return true
        }
        const subscription = subscriptionPath.exec(url.pathname)
        if (subscription && (request.method === 'POST' || request.method === 'DELETE')) {
          const connection = connections.get(subscription[1])
          if (!connection) throw new HttpError(410, 'Event stream ended')
          const sub = Number(subscription[2])
          if (request.method === 'DELETE') {
            const close = connection.subscriptions.get(sub)
            connection.subscriptions.delete(sub)
            // Not open (yet): its POST, still opening or not arrived, must not start it.
            if (close) await close()
            else connection.closed.add(sub)
          } else {
            const data = await body(request)
            const docs = data.docs ?? []
            if (!Array.isArray(docs) || !docs.every((kind) => typeof kind === 'string'))
              throw new HttpError(400, 'Invalid document kinds')
            await subscribe(
              connection,
              sub,
              conversationParam(data.conversation),
              docs,
              data.view !== false,
            )
          }
          json(200, { ok: true })
          return true
        }
        const history = /^\/api\/conversations\/(\d+)\/history$/.exec(url.pathname)
        if (request.method === 'GET' && history) {
          const id = Number(history[1])
          const before = Number(url.searchParams.get('before'))
          // `after` bounds the page from below, so a reveal reads down to one entry in large pages.
          const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : 0
          if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            !Number.isSafeInteger(before) ||
            before < 1 ||
            !Number.isSafeInteger(after) ||
            after < 0
          )
            throw new HttpError(400, 'Invalid history cursor or conversation id')
          const size = after ? 512 : 64
          const page = await backend.read(async () => {
            const conversation = await harness.conversation(id as ConversationId, context)
            if (!conversation) throw new HttpError(404, 'Unknown conversation')
            return conversation.entries(
              {
                maxEntryId: (before - 1) as EntryId,
                ...(after && { minEntryId: after as EntryId }),
              },
              size + 1,
              undefined,
              context,
            )
          })
          const entries = page.items.slice(0, size)
          json(200, {
            entries,
            before: page.items.length > size ? entries.at(-1)!.id : undefined,
          })
          return true
        }
        if (request.method === 'GET' && url.pathname === '/api/models') {
          json(200, await listModels(host.modelRuntime))
          return true
        }
        if (request.method !== 'POST') throw new HttpError(404, 'Unknown endpoint')
        const action = actionPath.exec(url.pathname)
        // Submissions carry images and actions can carry media (a voice recording); other commands stay small.
        const data = await body(
          request,
          action || /^\/api\/conversations\/\d+\/submit$/.test(url.pathname)
            ? 12 * 1024 * 1024
            : undefined,
        )
        if (action) {
          await runAction(request, response, extensions, action, data)
          return true
        }
        if (url.pathname === '/api/ui') {
          const set = data.set === undefined ? {} : data.set
          const remove = data.delete === undefined ? [] : data.delete
          if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(remove))
            throw new HttpError(400, 'Invalid UI update')
          if (!Object.keys(set).every(validUiKey) || !remove.every(validUiKey))
            throw new HttpError(400, 'Invalid UI key')
          if (UI_REVISION in set || remove.includes(UI_REVISION))
            throw new HttpError(400, 'The UI revision is the server’s')
          const rev = await harness.commit(async (tx) => {
            const value = await tx.doc(UiState, ROOT_CONVERSATION_ID)
            const next = { ...value, ...(set as Record<string, JsonValue>) }
            for (const key of remove) delete next[key]
            if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024)
              throw new HttpError(413, 'UI state too large')
            for (const [key, item] of Object.entries(set)) value[key] = item as JsonValue
            for (const key of remove) delete value[key]
            // Counted in the write's own commit, so a client knows which stream snapshot first carries it.
            const previous = value[UI_REVISION]
            const counted = (typeof previous === 'number' ? previous : 0) + 1
            value[UI_REVISION] = counted
            return counted
          }, context)
          json(200, { ok: true, rev })
          return true
        }
        if (url.pathname === '/api/restart') {
          const error = await host.restart(async (generation) => {
            json(202, { ok: true, generation })
          })
          if (!response.writableEnded) json(500, { ok: false, error })
          return true
        }
        const conversations = backend.channelHost.conversations
        if (url.pathname === '/api/conversations') {
          const { id } = await conversations.create({
            ...(data.cwd !== undefined && { cwd: text(data.cwd, 'cwd') }),
            ...(data.title !== undefined && { title: text(data.title, 'title') }),
            // The shared host validates the selection before it creates anything; undefined fields are absent.
            ...({
              definition: data.definition,
              preset: data.preset,
              model: data.model,
              thinkingLevel: data.thinkingLevel,
            } as Pick<
              CreateConversationRequest,
              'definition' | 'preset' | 'model' | 'thinkingLevel'
            >),
          })
          json(201, { id })
          return true
        }
        const cancel = /^\/api\/conversations\/(\d+)\/inbox\/(\d+)\/cancel$/.exec(url.pathname)
        if (cancel) {
          try {
            await conversations.cancelQueuedInput(routeId(cancel[1]), Number(cancel[2]))
          } catch (error) {
            // Route IDs that name no input, as before, whatever the reason.
            if (
              isChannelError(error) &&
              (error.code === 'not_found' || error.code === 'invalid_input')
            )
              throw new HttpError(404, 'Unknown queued input')
            throw error
          }
          json(200, { ok: true })
          return true
        }
        const match = /^\/api\/conversations\/(\d+)\/(submit|abort|configure|compact)$/.exec(
          url.pathname,
        )
        if (match) {
          const id = routeId(match[1])
          switch (match[2]) {
            case 'submit':
              try {
                // The web names its device itself; a browser cannot claim a channel source.
                const { submissionId } = await backend.submit(
                  id,
                  {
                    text: data.text,
                    images: data.images,
                    whenBusy: data.whenBusy,
                    requestId: data.requestId,
                  } as SubmitRequest,
                  deviceOf(request.headers),
                )
                json(202, { submissionId })
              } catch (error) {
                if (error instanceof Error && error.name === 'InputLimitError')
                  throw new HttpError(413, error.message)
                throw error
              }
              break
            case 'abort':
              await conversations.stop(id)
              json(200, { ok: true })
              break
            case 'configure':
              await conversations.configure(id, data)
              json(200, { ok: true })
              break
            case 'compact':
              json(202, { taskId: await backend.compact(id, data) })
              break
          }
          return true
        }
        throw new HttpError(404, 'Unknown endpoint')
      } catch (error) {
        failed(response, error)
      }
      return true
    },
    async close() {
      await Promise.all([...streams].map((stop) => stop()))
    },
  }
}

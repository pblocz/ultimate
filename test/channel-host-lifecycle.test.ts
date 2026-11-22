import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { prepareFauxServer, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof prepareFauxServer>>

/** A server with project facets written before it loads them; `facets` gets the temporary home. */
async function fixture(facets: (home: string) => Record<string, string> = () => ({})) {
  const home = await temp('ultimate-channel-lifecycle-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  for (const [name, source] of Object.entries(facets(home))) await facet(projectRoot, name, source)
  const server = await prepareFauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  return { home, projectRoot, server }
}

async function facet(root: string, name: string, source: string) {
  const folder = join(root, '.ultimate/extensions', name)
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'server.ts')
  await writeFile(file, source)
  return file
}

function call<T>(server: Server, name: string, action: string, args: unknown = {}) {
  return server.extensions.invoke(
    name,
    action,
    args as never,
    new AbortController().signal,
  ) as Promise<T>
}

const read = (file: string) => readFile(file, 'utf8').catch(() => '')

it('keeps initialization reads open, rejects early writes, and runs ready callbacks after open', async () => {
  const marks = (home: string) => ({
    readyHealthy: join(home, 'ready-healthy'),
    openFailedReady: join(home, 'open-failed-ready'),
    setupOpen: join(home, 'setup-open'),
    setupReady: join(home, 'setup-ready'),
  })
  const { home, server } = await fixture((root) => {
    const files = marks(root)
    return {
      'ready-probe': `import { defineExtension } from '@earendil-works/pi-durable'
let host, port
const state = { order: [], readCount: 0, earlyCode: '', readyCount: 0, lateCount: 0, receipt: null }
export default h => {
  host = h
  port = h.channelHost()
  h.onOpen(async () => {
    state.order.push('open')
    state.readCount = (await port.conversations.list()).length
    try { await port.conversations.create({ title: 'too early' }) }
    catch (error) { state.earlyCode = error.code }
  })
  h.onReady(async () => {
    state.order.push('ready')
    state.readyCount++
    state.receipt = await port.conversations.submit(1, { text: 'ready input', requestId: 'ready-' + state.readyCount })
  })
  return defineExtension({ name: 'ready-probe' })
}
export const actions = {
  state: async () => ({ ...state, order: [...state.order] }),
  list: async () => port.conversations.list(),
  register: async () => { host.onReady(async () => { state.lateCount++ }); return true },
}`,
      'backend-fails': `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
export default host => {
  host.onOpen(async () => { await writeFile(${JSON.stringify(files.setupOpen)}, 'ran') })
  host.onReady(async () => { await writeFile(${JSON.stringify(files.setupReady)}, 'ran') })
  return defineExtension({ name: 'backend-fails' })
}`,
      'open-fails': `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
export default host => {
  host.onOpen(async () => { throw new Error('open callback failed') })
  host.onReady(async () => { await writeFile(${JSON.stringify(files.openFailedReady)}, 'ran') })
  return defineExtension({ name: 'open-fails' })
}`,
      'ready-fails': `import { defineExtension } from '@earendil-works/pi-durable'
export default host => {
  host.onReady(async () => { throw new Error('optional readiness failed') })
  return defineExtension({ name: 'ready-fails' })
}`,
      'ready-healthy': `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
export default host => {
  host.onReady(async () => { await writeFile(${JSON.stringify(files.readyHealthy)}, 'healthy') })
  return defineExtension({ name: 'ready-healthy' })
}`,
    }
  })
  const files = marks(home)
  try {
    await expect(call(server, 'ready-probe', 'list')).rejects.toMatchObject({ code: 'unavailable' })
    const originalOpen = server.host.open.bind(server.host)
    server.host.open = async (resume) => {
      const opened = await originalOpen(resume)
      opened.harness.observeTaskGraph = async () => {
        throw new Error('backend setup failed')
      }
      return opened
    }
    await expect(server.go()).rejects.toThrow('backend setup failed')
    expect(await read(files.setupOpen)).toBe('')
    expect(await read(files.setupReady)).toBe('')
    await expect(call(server, 'ready-probe', 'list')).rejects.toMatchObject({ code: 'unavailable' })

    server.host.open = originalOpen
    server.host.faux!.setResponses([fauxAssistantMessage('Ready response')])
    const opened = await server.go()
    const state = await call<{
      order: string[]
      readCount: number
      earlyCode: string
      receipt: { submissionId: number }
    }>(server, 'ready-probe', 'state')
    expect(state).toMatchObject({
      order: ['open', 'ready'],
      readCount: 1,
      earlyCode: 'unavailable',
    })
    expect(state.receipt.submissionId).toBeGreaterThan(0)
    await opened.harness.waitForIdle(context)
    await until(async () => (await read(files.readyHealthy)) === 'healthy')
    await until(async () =>
      (await server.extensions.info.diagnostics()).includes(
        'Extension onReady failed: Error: optional readiness failed',
      ),
    )
    expect(await read(files.openFailedReady)).toBe('')

    await call(server, 'ready-probe', 'register')
    await until(
      async () =>
        (await call<{ lateCount: number }>(server, 'ready-probe', 'state')).lateCount === 1,
    )
  } finally {
    await server.close()
  }
})

it('runs facet readiness on hot enable, reload, and reacquire, while failed replacements retain the active facet', async () => {
  const { home, projectRoot, server } = await fixture()
  const log = join(home, 'lifecycle.log')
  const name = 'channel-probe'
  // Each load is a new instance; the watcher can report one save twice, so lines name their instance.
  const source = (version: number) => `import { defineExtension } from '@earendil-works/pi-durable'
import { appendFile } from 'node:fs/promises'
let hostRef, port, instance
const line = (event) => appendFile(${JSON.stringify(log)}, event + '-${version}-' + instance + '\\n')
export const registerReady = () => hostRef.onReady(async () => appendFile(${JSON.stringify(log)}, 'stale-ready\\n'))
export default host => {
  hostRef = host
  instance = globalThis.__channelProbe = (globalThis.__channelProbe ?? 0) + 1
  port = host.channelHost()
  host.onOpen(async () => line('open'))
  host.onReady(async () => line('ready'))
  host.onRelease(async () => line('release'))
  host.onClose(async () => {
    try { await port.conversations.list(); await line('close-open') }
    catch (error) { await line('close-' + error.code) }
  })
  return defineExtension({ name: '${name}' })
}
export const actions = {
  version: async () => ${version},
  instance: async () => instance,
  list: async () => port.conversations.list(),
}
`
  const instance = () => call<number>(server, name, 'instance')
  try {
    await server.go()
    const file = await facet(projectRoot, name, source(1))
    server.vite.watcher.emit('add', file)
    await until(() => server.extensions.action(name, 'version') !== undefined)
    await until(async () => (await read(log)).includes(`ready-1-${await instance()}`))
    const stale = (await server.vite.ssrLoadModule(file)).registerReady as () => void

    await writeFile(
      file,
      `import { defineExtension } from '@earendil-works/pi-durable'; throw new Error('failed replacement'); export default defineExtension({ name: '${name}' })`,
    )
    server.vite.watcher.emit('change', file)
    await until(
      () =>
        server.extensions
          .info()
          .find((entry) => entry.name === name)
          ?.server?.error?.includes('failed replacement') === true,
    )
    expect(await call(server, name, 'version')).toBe(1)

    await writeFile(file, source(2))
    server.vite.watcher.emit('change', file)
    await until(async () => (await call(server, name, 'version')) === 2)
    const loaded = await instance()
    await until(async () => (await read(log)).includes(`ready-2-${loaded}`))
    stale()
    expect(await read(log)).toContain('close-unavailable-1')
    expect(await read(log)).not.toContain('close-open')

    const current = await instance()
    await writeFile(log, '')
    await server.release()
    await expect(call(server, name, 'list')).rejects.toMatchObject({ code: 'unavailable' })
    const reopened = await server.go()
    expect(await call(server, name, 'list')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reopened.root.id })]),
    )
    // Reopening reruns the active facet's openers; activation can also reload it, and each reload becomes ready.
    await until(async () => (await read(log)).includes(`ready-2-${await instance()}`))
    expect(await read(log)).toContain(`release-2-${current}`)
    expect(await read(log)).toContain(`open-2-${current}`)

    await mkdir(join(home, '.ultimate'), { recursive: true })
    const settings = join(home, '.ultimate/settings.json')
    await writeFile(log, '')
    await writeFile(settings, JSON.stringify({ extensions: { disable: [name] } }))
    server.vite.watcher.emit('change', settings)
    await until(
      () => server.extensions.info().find((entry) => entry.name === name)?.enabled === false,
    )
    await until(async () => (await read(log)).includes('close-unavailable-'))
    await writeFile(settings, JSON.stringify({ extensions: { enable: [name] } }))
    server.vite.watcher.emit('change', settings)
    await until(
      () => server.extensions.info().find((entry) => entry.name === name)?.enabled === true,
    )
    await until(async () => (await read(log)).includes(`ready-2-${await instance()}`))
    expect(await read(log)).not.toContain('close-open')
    expect(await read(log)).not.toContain('stale-ready')
  } finally {
    await server.close()
  }
})

it('closes shared admission synchronously, rechecks legacy and channel mutations after validation, and waits for active calls', async () => {
  const name = 'admission-race'
  const { home, server } = await fixture((root) => ({
    [name]: `import { defineExtension } from '@earendil-works/pi-durable'
import { writeFile } from 'node:fs/promises'
let port
export default host => {
  port = host.channelHost()
  host.onRelease(async () => writeFile(${JSON.stringify(join(root, 'released'))}, 'released'))
  return defineExtension({ name: '${name}' })
}
export const actions = {
  configure: async ({ thinkingLevel }) =>
    port.conversations.configure(1, { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel }),
}
`,
  }))
  const marker = join(home, 'released')
  try {
    const opened = await server.go()
    const url = server.url
    if (!url) throw new Error('The fixture has no web endpoint')
    // Pi's levels for this model: off, low, high.
    Object.assign(server.host.faux!.models[0], {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    })
    const before = (await opened.root.agent(context)).thinkingLevel
    const thinkingLevel = before === 'low' ? 'high' : 'low'
    const originalModels = server.host.models
    const bothStarted = Promise.withResolvers<void>()
    const validation = Promise.withResolvers<void>()
    let calls = 0
    server.host.models = async () => {
      if (++calls === 2) bothStarted.resolve()
      await validation.promise
      return originalModels()
    }
    const channelCall = call(server, name, 'configure', { thinkingLevel })
    const webCall = fetch(url + '/api/conversations/1/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel }),
    }).then((response) => response.status)
    await bothStarted.promise

    let released = false
    const closing = server.release().then(() => {
      released = true
    })
    await until(async () => (await read(marker)) === 'released')
    expect(released).toBe(false)
    await expect(call(server, name, 'configure', { thinkingLevel })).rejects.toMatchObject({
      code: 'unavailable',
    })
    const rejectedWebCall = await fetch(url + '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({}),
    })
    expect(rejectedWebCall.status).toBe(503)

    validation.resolve()
    await expect(channelCall).rejects.toMatchObject({ code: 'unavailable' })
    expect(await webCall).toBe(503)
    await closing
    expect(released).toBe(true)

    server.host.models = originalModels
    const reopened = await server.go()
    expect((await reopened.root.agent(context)).thinkingLevel).toBe(before)
  } finally {
    await server.close()
  }
})

it('releases before final facet cleanup exactly once without an explicit release call', async () => {
  const { home, server } = await fixture((root) => ({
    'final-close-probe': `import { defineExtension } from '@earendil-works/pi-durable'
import { appendFile } from 'node:fs/promises'
const log = ${JSON.stringify(join(root, 'final-close'))}
export default host => {
  host.onRelease(async () => appendFile(log, 'release\\n'))
  host.onClose(async () => appendFile(log, 'close\\n'))
  return defineExtension({ name: 'final-close-probe' })
}`,
  }))
  await server.go()
  await server.close()
  await server.close()
  expect(await read(join(home, 'final-close'))).toBe('release\nclose\n')
})

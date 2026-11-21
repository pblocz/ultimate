import { createServer } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import type { ServerEvents } from '../shared/protocol.ts'
import { prepareFauxServer, until } from './helpers.ts'
import { fixture } from './server-fixture.ts'

/** Whether nothing listens on `port`: a test server can take it. */
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
const models = async (url: string) => (await fetch(`${url}/api/models`)).status

it('listens when enabled, releases the port on a live disable and binds it again on enable', async () => {
  const { server, options } = await fixture()
  const url = server.url
  const port = server.port
  expect(url).toBe(`http://127.0.0.1:${port}`)
  expect(server.system.current().process.url).toBe(url)
  expect(await models(url)).toBe(200)
  const settings = join(options.projectRoot, '.ultimate/settings.json')
  const original = await readFile(settings, 'utf8')
  const { extensions } = JSON.parse(original) as { extensions: { enable: string[] } }
  await writeFile(settings, JSON.stringify({ extensions: { ...extensions, disable: ['web'] } }))
  server.vite.watcher.emit('change', settings)
  // System info follows on its next refresh.
  await until(() => server.url === undefined && server.system.current().process.url === undefined)
  expect(await free(port)).toBe(true)
  // The runtime goes on: work is admitted and answered without the browser.
  server.host.faux!.setResponses([fauxAssistantMessage('Answered without a browser')])
  await (await server.root.submit({ type: 'input', content: 'still here' }, context)).wait(context)
  expect(JSON.stringify((await server.root.context(context)).entries)).toContain(
    'Answered without a browser',
  )
  await writeFile(settings, original)
  server.vite.watcher.emit('change', settings)
  await until(() => server.url !== undefined)
  expect(server.url).toBe(url)
  expect(await models(url)).toBe(200)
})

it('binds the same port again after a release, a new activation and a reload of its facet', async () => {
  const { server, options } = await fixture()
  const { url, port } = server
  await server.release()
  expect(server.url).toBeUndefined()
  expect(await free(port)).toBe(true)
  await server.go()
  expect(server.url).toBe(url)
  expect(await models(url)).toBe(200)
  const facet = join(options.ultimateRoot, 'extensions/web/server.ts')
  const loadedAt = () =>
    server.extensions.info().find((extension) => extension.name === 'web')?.server?.loadedAt
  const before = loadedAt()
  await writeFile(facet, (await readFile(facet, 'utf8')) + '\n// reloaded\n')
  server.vite.watcher.emit('change', facet)
  await until(() => loadedAt() !== before && server.url !== undefined)
  expect(server.url).toBe(url)
  expect(await models(url)).toBe(200)
})

it('keeps the runtime and says why when its port is taken', async () => {
  const { options } = await fixture()
  const taken = createServer()
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
  const port = (taken.address() as { port: number }).port
  try {
    const server = await prepareFauxServer({
      ...options,
      home: join(options.home, 'taken'),
      port,
    })
    const notices: string[] = []
    server.events.listeners.add((name, data) => {
      if (name === 'notice') notices.push((data as ServerEvents['notice']).message)
    })
    try {
      const opened = await server.go()
      expect(server.url).toBeUndefined()
      expect(notices.join('\n')).toContain(`The web channel cannot listen on 127.0.0.1:${port}`)
      server.host.faux!.setResponses([fauxAssistantMessage('Runs without a port')])
      await (await opened.root.submit({ type: 'input', content: 'hello' }, context)).wait(context)
      expect(JSON.stringify((await opened.root.context(context)).entries)).toContain(
        'Runs without a port',
      )
    } finally {
      await server.vite.watcher.close()
      await server.close()
    }
  } finally {
    taken.close()
  }
})

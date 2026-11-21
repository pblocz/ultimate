import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import type { Delivered } from './fake-channel.ts'
import { prepareFauxServer, sourceCopy, temp, until } from './helpers.ts'

/** Listening TCP servers of this process: the runtime must add none without a web channel. */
const listeners = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length

const adapter = resolve('test/fake-channel.ts')
const facet = `import { defineExtension } from '@earendil-works/pi-durable'
import { fakeChannel } from ${JSON.stringify(adapter)}
let channel
const listening = new Map()
export default (host) => {
  channel = fakeChannel(host.channelHost(), 'chat')
  return defineExtension({ name: 'fake-chat' })
}
export const actions = {
  receive: (message) => channel.receive(message),
  delivered: async () => channel.delivered,
  binding: async ({ chatId }) => channel.bindings.get(chatId) ?? null,
  listen: async ({ chatId }) => {
    const controller = new AbortController()
    listening.set(chatId, controller)
    channel.listen(chatId, controller.signal).catch(() => {})
    return true
  },
  unlisten: async ({ chatId }) => { listening.get(chatId)?.abort(); return true },
}
`
const echo: FauxResponseFactory = (request) => {
  const content = request.messages.findLast((message) => message.role === 'user')?.content
  const text =
    typeof content === 'string'
      ? content
      : (content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  return fauxAssistantMessage(`Answer: ${text}`)
}

it('runs, admits, watches and reads history through a channel with no browser files and no listener', async () => {
  const home = await temp('ultimate-no-web-')
  const ultimateRoot = await sourceCopy(home)
  // No browser sources, no web channel: nothing in the runtime may need them.
  await rm(join(ultimateRoot, 'web'), { recursive: true })
  await rm(join(ultimateRoot, 'extensions/web'), { recursive: true, force: true })
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate/extensions/fake-chat'), { recursive: true })
  await writeFile(join(projectRoot, '.ultimate/extensions/fake-chat/server.ts'), facet)
  const before = listeners()
  const server = await prepareFauxServer({
    ultimateRoot,
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  const call = <T>(action: string, args: unknown = {}) =>
    server.extensions.invoke(
      'fake-chat',
      action,
      args as never,
      new AbortController().signal,
    ) as Promise<T>
  const delivered = async () => (await call<Delivered[]>('delivered')).map((item) => item.text)
  try {
    expect(existsSync(join(ultimateRoot, 'web'))).toBe(false)
    expect(server.extensions.info().some((extension) => extension.name === 'fake-chat')).toBe(true)
    let opened = await server.go()
    expect(server.url).toBeUndefined()
    expect(opened.system.current().process.url).toBeUndefined()
    expect(listeners()).toBe(before)
    // Titles and summaries call the model too; each call gets the echo.
    server.host.faux!.setResponses(Array.from({ length: 40 }, () => echo))
    await call('receive', { chatId: 'alice', messageId: '1', text: 'hello' })
    await opened.harness.waitForIdle(context)
    // The adapter listens to chats it has bound; listening reads what was committed since.
    await call('listen', { chatId: 'alice' })
    await until(async () => (await delivered()).includes('Answer: hello'))
    await call('unlisten', { chatId: 'alice' })
    // A release and a new activation (what a supervised swap does to one process) open no listener either.
    await server.release()
    expect(listeners()).toBe(before)
    opened = await server.go()
    expect(listeners()).toBe(before)
    await call('receive', { chatId: 'alice', messageId: '2', text: 'again' })
    await opened.harness.waitForIdle(context)
    await call('listen', { chatId: 'alice' })
    await until(async () => (await delivered()).includes('Answer: again'))
    expect(await delivered()).toEqual(['Answer: hello', 'Answer: again'])
    expect(server.conversations().map((summary) => summary.id)).toContain(
      await call<number>('binding', { chatId: 'alice' }),
    )
  } finally {
    await server.close()
  }
  expect(listeners()).toBe(before)
})

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { AgentDoc, InboxDoc, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { afterEach, expect, it, vi } from 'vitest'
import { fauxServer, held, temp, until } from '../../../../test/helpers.ts'
import { writeSecret } from '../../../secrets/store.ts'
import { ledger } from '../../state.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.unstubAllEnvs()
})

async function fixture() {
  const home = await temp('ultimate-telegram-')
  const user = join(home, 'user')
  const state = join(home, 'state')
  await mkdir(join(user, '.ultimate'), { recursive: true })
  await writeFile(
    join(user, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { enable: ['telegram'], disable: ['web', 'dream', 'coding-workflow'] },
      telegram: { allow: ['7', '8'] },
    }),
  )
  await mkdir(join(user, '.ultimate/agents'))
  await writeFile(
    join(user, '.ultimate/agents/fixture.md'),
    '---\nname: fixture\ndescription: Test persona\n---\nTest instructions.\n',
  )
  await writeSecret(user, 'TELEGRAM_BOT_TOKEN', '42:fixture')
  type Update = { update_id: number; message: object }
  let next = 0
  let updates: Update[] = []
  let fail = false
  let polls = 0
  const sends: { chat_id: string; text: string }[] = []
  const stub = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += String(chunk)
    const body = JSON.parse(text || '{}') as {
      chat_id: string | number
      text: string
      offset?: number
      limit?: number
    }
    const method = req.url?.split('/').at(-1)
    const reply = (result: unknown) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, result }))
    }
    if (method === 'getMe')
      reply({ id: 42, is_bot: true, first_name: 'TestBot', username: 'fixture_bot' })
    else if (method === 'sendChatAction') reply(true)
    else if (method === 'sendMessage') {
      sends.push({ chat_id: String(body.chat_id), text: body.text })
      if (fail) req.socket.destroy()
      else
        reply({
          message_id: 100 + sends.length,
          date: 1,
          chat: { id: Number(body.chat_id), type: 'private' },
          text: body.text,
        })
    } else if (method === 'getUpdates') {
      polls++
      updates = updates.filter((update) => update.update_id >= (body.offset ?? 0))
      const timer = setTimeout(() => reply(updates.slice(0, body.limit)), 25)
      res.once('close', () => clearTimeout(timer))
    } else res.writeHead(404).end()
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  cleanup.push(async () => {
    stub.closeAllConnections()
    await new Promise<void>((done) => stub.close(() => done()))
  })
  vi.stubEnv('TELEGRAM_API_BASE_URL', `http://127.0.0.1:${(stub.address() as AddressInfo).port}`)
  const options = { ultimateRoot: resolve(), home: state, userHome: user }
  async function reopen(source = options.ultimateRoot) {
    const faux = fauxProvider({
      models: [
        { id: 'faux-1', reasoning: true },
        { id: 'faux-alt', reasoning: true },
      ],
    })
    const server = await fauxServer({ ...options, ultimateRoot: source, faux })
    cleanup.push(() => server.close())
    const respond: FauxResponseFactory = (request) => {
      server.host.faux!.appendResponses([respond])
      const input = request.messages.findLast((message) => message.role === 'user')
      const text = typeof input?.content === 'string' ? input.content : ''
      return fauxAssistantMessage(`Answer ${text}`.trim())
    }
    server.host.faux!.setResponses([respond])
    return server
  }
  return {
    sends,
    reopen,
    polls: () => polls,
    async disable() {
      await writeFile(
        join(user, '.ultimate/settings.json'),
        JSON.stringify({
          summaryModel: 'unavailable/test',
          extensions: { disable: ['telegram', 'web', 'dream', 'coding-workflow'] },
        }),
      )
    },
    loseSendResponse: () => {
      fail = true
    },
    add(chat: number, message: number, text: string, type = 'private') {
      const command = /^\/[^\s]+/.exec(text)?.[0]
      updates.push({
        update_id: ++next,
        message: {
          message_id: message,
          date: 1,
          chat: { id: chat, type },
          from: { id: chat, is_bot: false, first_name: 'Test' },
          text,
          ...(command && {
            entities: [{ type: 'bot_command', offset: 0, length: command.length }],
          }),
        },
      })
    },
  }
}

it('admits approved private chats separately and does not admit a repeated message twice', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  bot.add(9, 1, 'Denied user')
  bot.add(7, 1, 'Denied group', 'group')
  bot.add(7, 2, 'first')
  bot.add(7, 2, 'first')
  bot.add(8, 1, 'second')
  await until(() => bot.sends.length >= 2)
  expect(bot.sends.toSorted((a, b) => a.chat_id.localeCompare(b.chat_id))).toEqual([
    { chat_id: '7', text: 'Answer first' },
    { chat_id: '8', text: 'Answer second' },
  ])
  const saved = await durable.read()
  expect(Object.keys(saved.inputs).toSorted()).toEqual(['7:2', '8:1'])
  expect(saved.chats['7']).not.toBe(saved.chats['8'])
  expect(server.url).toBeUndefined()
})

it('steers a busy conversation through the native inbox', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  const started = Promise.withResolvers<void>()
  server.host.faux!.setResponses([
    (request, options, state, model) => {
      started.resolve()
      return held(request, options, state, model)
    },
  ])
  bot.add(7, 1, 'Start a turn')
  await started.promise
  bot.add(7, 2, 'Steer this turn')
  await until(async () => (await durable.read()).inputs['7:2']?.submission !== undefined)
  const id = (await durable.read()).chats['7'] as ConversationId
  const inbox = await server.harness.snapshot(InboxDoc, id, context)
  expect(inbox?.items).toEqual([
    expect.objectContaining({ mode: 'steer', content: 'Steer this turn' }),
  ])
})

it('reads and changes only the current chat and preserves its persona on a clear', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  bot.add(7, 1, 'Set up the first chat')
  bot.add(8, 1, 'Set up the second chat')
  await until(
    async () =>
      (await durable.read()).inputs['7:1']?.settled === true &&
      (await durable.read()).inputs['8:1']?.settled === true,
  )
  const first = (await durable.read()).chats['7'] as ConversationId
  const second = (await durable.read()).chats['8'] as ConversationId
  const untouched = await server.harness.snapshot(AgentDoc, second, context)
  let sequence = 1
  const command = async (text: string, prefix: string) => {
    const start = bot.sends.length
    bot.add(7, ++sequence, text)
    await until(() =>
      bot.sends.slice(start).some((send) => send.chat_id === '7' && send.text.startsWith(prefix)),
    )
    return bot.sends
      .slice(start)
      .find((send) => send.chat_id === '7' && send.text.startsWith(prefix))!.text
  }
  const help = await command('/help', '/clear or /new')
  expect(help).toContain('/followup <text>')
  const stats = await command('/stats', 'Context:')
  const usage = (await server.harness.snapshot(UsageDoc, first, context))?.models['faux/faux-1']
  if (!usage) throw new Error('The first chat has no recorded model usage')
  expect(usage.output).toBeGreaterThan(0)
  expect(stats.split('\n').slice(1)).toEqual([
    `Input: ${usage.input} tokens`,
    `Output: ${usage.output} tokens`,
    `Cache read: ${usage.cacheRead} tokens`,
    `Cache write: ${usage.cacheWrite} tokens`,
    `Recorded cost: $${usage.cost.total.toFixed(4)}`,
  ])
  expect(await command('/model', 'Model:')).toContain('faux/faux-alt')
  await command('/model faux/faux-alt', 'Model: faux/faux-alt')
  await command('/model invalid-missing', 'Unknown model preset:')
  await command('/model faux/unavailable', 'Model is not available')
  expect(await command('/thinking', 'Thinking:')).toContain('Levels:')
  await command('/thinking low', 'Thinking: low')
  await command('/thinking invalid', 'faux/faux-alt does not support thinking level')
  expect(await command('/persona', 'Persona:')).toContain('Available personas:')
  await command('/persona fixture', 'Persona: fixture')
  await command('/persona missing', 'Unknown agent definition: missing')
  await command('/compact', 'Compaction requested.')
  await command('/new', 'Started a fresh conversation.')
  const current = (await durable.read()).chats['7'] as ConversationId
  expect(current).not.toBe(first)
  expect((await durable.read()).chats['8']).toBe(second)
  const configured = await server.harness.snapshot(AgentDoc, current, context)
  expect(configured).toMatchObject({
    model: { provider: 'faux', modelId: 'faux-alt' },
    thinkingLevel: 'low',
  })
  expect(JSON.stringify(configured)).toContain('Test instructions.')
  expect(await server.harness.snapshot(AgentDoc, second, context)).toEqual(untouched)
})

it('queues a follow-up and stops only the active run', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const state = ledger(server.harness, '42')
  const started = Promise.withResolvers<void>()
  server.host.faux!.setResponses([
    (request, options, modelState, model) => {
      started.resolve()
      return held(request, options, modelState, model)
    },
  ])
  bot.add(7, 1, 'Hold the turn')
  await started.promise
  bot.add(7, 2, '/followup Wait until later')
  await until(async () => (await state.read()).inputs['7:2']?.submission !== undefined)
  const id = (await state.read()).chats['7'] as ConversationId
  const queued = (await server.harness.snapshot(InboxDoc, id, context))?.items
  expect(queued).toEqual([expect.objectContaining({ content: 'Wait until later' })])
  expect(queued?.[0].mode).not.toBe('steer')
  bot.add(7, 3, '/stop')
  await until(() => bot.sends.some((send) => send.text === 'Stopped the active run.'))
  expect((await server.harness.snapshot(LiveDoc, id, context))?.run).toBeUndefined()
  expect((await server.harness.snapshot(InboxDoc, id, context))?.items).toEqual(queued)
})

it('keeps the old reply in its source chat and replays clear without creating a new conversation', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const state = ledger(server.harness, '42')
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  server.host.faux!.setResponses([
    async () => {
      started.resolve()
      await release.promise
      return fauxAssistantMessage('Old answer')
    },
  ])
  bot.add(7, 1, 'Old turn')
  await started.promise
  try {
    const old = (await state.read()).chats['7']
    bot.add(7, 2, '/clear')
    await until(async () => !!(await state.read()).clears['7:2'])
    const fresh = (await state.read()).chats['7']
    expect(fresh).not.toBe(old)
    release.resolve()
    await until(() => bot.sends.some((send) => send.text === 'Old answer'))
    expect(bot.sends.find((send) => send.text === 'Old answer')?.chat_id).toBe('7')
    await server.close()
    const next = await bot.reopen(server.host.ultimateRoot)
    const reopened = ledger(next.harness, '42')
    bot.add(7, 2, '/clear')
    bot.add(7, 3, 'New turn')
    await until(() => bot.sends.some((send) => send.text === 'Answer New turn'))
    const saved = await reopened.read()
    expect(saved.clears['7:2']).toBe(fresh)
    expect(saved.chats['7']).toBe(fresh)
    expect(saved.inputs['7:1'].conversation).toBe(old)
    expect(saved.inputs['7:3'].conversation).toBe(fresh)
    expect(bot.sends.filter((send) => send.text === 'Started a fresh conversation.')).toHaveLength(
      1,
    )
    expect(bot.sends.filter((send) => send.text === 'Old answer')).toHaveLength(1)
  } finally {
    release.resolve()
  }
})

it('stops polling on disable but lets admitted work finish with the web off', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  server.host.faux!.setResponses([
    async () => {
      started.resolve()
      await release.promise
      return fauxAssistantMessage('Finished after disable')
    },
  ])
  bot.add(7, 1, 'Finish this turn')
  await started.promise
  try {
    await until(async () => (await durable.read()).inputs['7:1']?.submission !== undefined)
    await bot.disable()
    await until(
      () => server.extensions.info().find((entry) => entry.name === 'telegram')?.enabled === false,
    )
    const polls = bot.polls()
    bot.add(7, 2, 'Do not admit this')
    release.resolve()
    await server.harness.waitForIdle(context)
    const saved = await durable.read()
    const id = saved.chats['7'] as ConversationId
    const chat = (await server.harness.conversation(id, context))!
    expect(JSON.stringify((await chat.context(context)).entries)).toContain(
      'Finished after disable',
    )
    expect(saved.inputs['7:2']).toBeUndefined()
    expect(bot.polls()).toBe(polls)
    expect(bot.sends).toEqual([])
    expect(server.url).toBeUndefined()
  } finally {
    release.resolve()
  }
})

it('does not send a reply again after a restart when Telegram did not confirm it', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  bot.loseSendResponse()
  bot.add(7, 1, 'once')
  await until(async () =>
    Object.values((await durable.read()).deliveries).some((item) => item.status === 'uncertain'),
  )
  expect(bot.sends).toHaveLength(1)
  await server.close()
  const next = await bot.reopen(server.host.ultimateRoot)
  const after = ledger(next.harness, '42')
  bot.add(7, 1, 'once')
  bot.add(8, 2, 'next')
  await until(async () => (await after.read()).inputs['8:2']?.settled === true)
  expect(bot.sends.filter(({ chat_id }) => chat_id === '7')).toHaveLength(1)
  expect((await after.read()).inputs['7:1']).toMatchObject({ settled: true })
})

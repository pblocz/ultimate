import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { obj } from '@earendil-works/pi-schema'
import {
  AgentDoc,
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  defineExtension,
  defineTool,
  hook,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { afterEach, expect, it, vi } from 'vitest'
import { fauxServer, held, sourceCopy, temp, until } from '@ultimate/test/helpers.ts'
import { activationFailure, copies, launch } from '@ultimate/test/e2e/supervisor-helpers.ts'
import { writeSecret } from '@ultimate/ext/secrets/store.ts'
import { ledger } from '../../state.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.unstubAllEnvs()
})

it('clears the missing bot token notice when the token is saved', async () => {
  const bot = await fixture(false)
  const server = await bot.reopen()
  const warning = 'Telegram: set TELEGRAM_BOT_TOKEN in Secrets.'
  await until(() => server.system.current().extensionDiagnostics.includes(warning))
  expect(bot.polls()).toBe(0)
  await bot.saveToken()
  await until(() => !server.system.current().extensionDiagnostics.includes(warning))
})

async function fixture(withToken = true) {
  const home = await temp('ultimate-telegram-')
  const user = join(home, 'user')
  const state = join(home, 'state')
  await mkdir(join(user, '.ultimate'), { recursive: true })
  await writeFile(
    join(user, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: {
        enable: ['telegram'],
        disable: ['web', 'dream', 'coding-workflow', 'supercoordinator'],
      },
      telegram: { allow: ['7', '8'] },
    }),
  )
  await mkdir(join(user, '.ultimate/agents'))
  await writeFile(
    join(user, '.ultimate/agents/fixture.md'),
    '---\nname: fixture\ndescription: Test persona\n---\nTest instructions.\n',
  )
  const saveToken = () => writeSecret(user, 'TELEGRAM_BOT_TOKEN', '42:fixture')
  if (withToken) await saveToken()
  type Update = { update_id: number; message: object }
  let next = 0
  let updates: Update[] = []
  let failAt = Infinity
  let rejectAt = Infinity
  let failMenu = false
  let polls = 0
  const typing: string[] = []
  const edits: { chat: string; message: number; text: string }[] = []
  let failEdit = false
  const reactions: { chat: string; message: number; emoji?: string }[] = []
  let typingMode: 'lose' | 'rate' | 'stall' | undefined
  const menus: { commands: { command: string; description: string }[]; scope: object }[] = []
  const sends: { chat_id: string; text: string; parse_mode?: string }[] = []
  const stub = createServer(async (req, res) => {
    if (req.url?.startsWith('/file/')) {
      res
        .writeHead(200, { 'content-type': 'image/jpeg' })
        .end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return
    }
    let text = ''
    for await (const chunk of req) text += String(chunk)
    const body = JSON.parse(text || '{}') as {
      chat_id: string | number
      text: string
      offset?: number
      limit?: number
      commands?: { command: string; description: string }[]
      scope?: object
      parse_mode?: string
      message_id?: number
      reaction?: { emoji: string }[]
    }
    const method = req.url?.split('/').at(-1)
    const reply = (result: unknown) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, result }))
    }
    if (method === 'getMe')
      reply({ id: 42, is_bot: true, first_name: 'TestBot', username: 'fixture_bot' })
    else if (method === 'sendChatAction') {
      typing.push(String(body.chat_id))
      if (typingMode === 'lose') {
        typingMode = undefined
        req.socket.destroy()
      } else if (typingMode === 'rate') {
        typingMode = undefined
        res.writeHead(429, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 1 },
          }),
        )
      } else if (typingMode !== 'stall') reply(true)
    } else if (method === 'setMessageReaction') {
      reactions.push({
        chat: String(body.chat_id),
        message: body.message_id!,
        emoji: body.reaction?.[0]?.emoji,
      })
      reply(true)
    } else if (method === 'setMyCommands') {
      menus.push({ commands: body.commands ?? [], scope: body.scope ?? {} })
      if (failMenu) res.writeHead(500).end()
      else reply(true)
    } else if (method === 'getFile') {
      reply({ file_id: (body as { file_id?: string }).file_id, file_path: 'photos/test.jpg' })
    } else if (method === 'editMessageText') {
      edits.push({ chat: String(body.chat_id), message: body.message_id!, text: body.text })
      if (failEdit) req.socket.destroy()
      else
        reply({
          message_id: body.message_id,
          date: 1,
          chat: { id: Number(body.chat_id), type: 'private' },
          text: body.text,
        })
    } else if (method === 'sendMessage') {
      sends.push({ chat_id: String(body.chat_id), text: body.text, parse_mode: body.parse_mode })
      if (sends.length === rejectAt)
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }))
      else if (sends.length === failAt) req.socket.destroy()
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
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
    }
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
    user,
    sends,
    typing,
    edits,
    loseEditResponse: () => {
      failEdit = true
    },
    reactions,
    setTypingMode(mode: typeof typingMode) {
      typingMode = mode
    },
    reopen,
    saveToken,
    polls: () => polls,
    async disable() {
      await writeFile(
        join(user, '.ultimate/settings.json'),
        JSON.stringify({
          summaryModel: 'unavailable/test',
          extensions: {
            disable: ['telegram', 'web', 'dream', 'coding-workflow', 'supercoordinator'],
          },
        }),
      )
    },
    loseSendResponse: (part = 1) => {
      failAt = sends.length + part
    },
    rejectSendResponse: (part = 1) => {
      rejectAt = sends.length + part
    },
    loseMenuUpdate: () => {
      failMenu = true
    },
    menus,
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
    addImage(chat: number, message: number, kind: 'photo' | 'document', caption = '') {
      updates.push({
        update_id: ++next,
        message: {
          message_id: message,
          date: 1,
          chat: { id: chat, type: 'private' },
          from: { id: chat, is_bot: false, first_name: 'Test' },
          caption,
          ...(kind === 'photo'
            ? {
                photo: [
                  { file_id: 'photo1', file_unique_id: 'u1', width: 10, height: 10, file_size: 4 },
                ],
              }
            : {
                document: {
                  file_id: 'document1',
                  file_unique_id: 'u2',
                  file_name: 'test.jpg',
                  mime_type: 'image/jpeg',
                  file_size: 4,
                },
              }),
        },
      })
    },
  }
}

it.each([false, true])(
  'publishes the private menu and serves help (menu failure: %s)',
  async (fail) => {
    const bot = await fixture()
    if (fail) bot.loseMenuUpdate()
    await bot.reopen()
    await until(() => bot.polls() > 0 && bot.menus.length > 0)
    expect(bot.menus).toEqual([
      {
        commands: [
          { command: 'clear', description: 'Start a fresh conversation' },
          { command: 'new', description: 'Start a fresh conversation' },
          { command: 'stop', description: 'Stop the current run' },
          { command: 'compact', description: 'Compact the current context' },
          { command: 'stats', description: 'Show context use, tokens, and recorded cost' },
          { command: 'model', description: 'Show or change the model' },
          { command: 'thinking', description: 'Show or change the thinking level' },
          { command: 'persona', description: 'Show or change the persona' },
          { command: 'followup', description: 'Send after the current run' },
          { command: 'restart', description: 'Restart the shared Ultimate host' },
          { command: 'help', description: 'Show these commands' },
        ],
        scope: { type: 'all_private_chats' },
      },
    ])
    bot.add(7, 1, '/help')
    await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
    expect(bot.sends[0].parse_mode).toBeUndefined()
    expect(bot.menus).toHaveLength(1)
  },
)

it.each([
  ['photo', 'look at this'],
  ['photo', ''],
  ['document', 'look at this'],
] as const)('passes a %s with caption %j to the model', async (kind, caption) => {
  const bot = await fixture()
  const server = await bot.reopen()
  let content: unknown
  server.host.faux!.setResponses([
    (request) => {
      content = request.messages.findLast((message) => message.role === 'user')?.content
      return fauxAssistantMessage('Answer image')
    },
  ])
  bot.addImage(7, 1, kind, caption)
  await until(() => bot.sends.length >= 1)
  expect(content).toEqual([
    ...(caption ? [{ type: 'text', text: caption }] : []),
    {
      type: 'image',
      mimeType: 'image/jpeg',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
    },
  ])
  expect(bot.sends).toEqual([{ chat_id: '7', text: 'Answer image', parse_mode: 'MarkdownV2' }])
})

it('reports a refused restart', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const restart = vi.fn<typeof server.host.restart>(async () => 'Restart refused')
  server.host.restart = restart
  bot.add(7, 1, '/restart')
  await until(() => bot.sends.length === 2)
  expect(restart).toHaveBeenCalledOnce()
  expect(bot.sends.map(({ text }) => text)).toEqual([
    'Restarting…',
    'Restart failed: Restart refused',
  ])
})

it('keeps a pending restart through a facet reload and releases the bot', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const restart = vi.fn<typeof server.host.restart>(async (approved) => {
    await approved(2)
    return new Promise<string>(() => {})
  })
  server.host.restart = restart
  bot.add(7, 1, '/restart')
  await until(() => restart.mock.calls.length === 1)
  bot.add(7, 2, '/help')
  await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
  const file = join(server.host.ultimateRoot, 'extensions/telegram/server.ts')
  await writeFile(
    file,
    (await readFile(file, 'utf8')) + '\n// Reload before the restart completes.\n',
  )
  await until(() => bot.menus.length === 2)
  expect((await ledger(server.harness, '42').read()).restart?.generation).toBe(2)
  expect(bot.sends).toHaveLength(2)
  await server.close()
  expect(restart).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'reports the supervised restart outcome once (activation failure: %s)',
  async (fail) => {
    const bot = await fixture()
    const root = await sourceCopy(await temp('ultimate-telegram-supervisor-'))
    await mkdir(join(root, 'extensions/telegram-probe'))
    await writeFile(
      join(root, 'extensions/telegram-probe/server.ts'),
      `import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
export default (host) => {
  host.onReady(() => appendFile(join(host.home, 'telegram-ready.jsonl'), JSON.stringify({ ...host.system().process, build: host.build().id }) + '\\n'))
  return { name: 'telegram-probe' }
}
`,
    )
    copies.set(bot.user, root)
    const running = await launch(bot.user)
    cleanup.push(async () => {
      if (running.child.exitCode !== null || running.child.signalCode !== null) return
      const exited = once(running.child, 'exit')
      running.child.kill('SIGTERM')
      await exited
    })
    const readies = async () =>
      (await readFile(join(bot.user, 'telegram-ready.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              generation: number
              pid: number
              build: string
              activationError?: string
            },
        )
    await until(async () => (await readies()).length === 1 && bot.menus.length === 1)
    const [first] = await readies()
    expect(first.generation).toBe(1)
    if (fail) await activationFailure(root)
    bot.add(7, 1, '/restart')
    await until(async () => (await readies()).length === 2 && bot.menus.length === 2)
    const ready = (await readies())[1]
    expect(ready.generation).toBe(fail ? 1 : 2)
    expect(ready.pid === first.pid).toBe(fail)
    expect(ready.activationError?.includes('Injected activation failure') ?? false).toBe(fail)
    const reply = fail
      ? `Restart failed during activation; rolled back to generation 1. ${ready.activationError}`
      : `Restarted. The shared Ultimate host is now running generation 2 (pid ${ready.pid}, build ${ready.build}).`
    await until(() => bot.sends.length >= 2)
    expect(bot.sends.map(({ text }) => text)).toEqual(['Restarting…', reply])
    bot.add(7, 2, 'after restart')
    await until(() => bot.sends.some(({ text }) => text.replaceAll('\\', '') === 'Done.'))
    const file = join(root, 'extensions/telegram/server.ts')
    await writeFile(file, (await readFile(file, 'utf8')) + '\n// Reload the Telegram facet.\n')
    await until(() => bot.menus.length === 3)
    bot.add(7, 3, '/help')
    await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
    expect(bot.sends.slice(0, 3).map(({ text }) => text)).toEqual(['Restarting…', reply, 'Done\\.'])
    expect(bot.sends).toHaveLength(4)
    expect(running.output()).not.toContain('Timed out waiting for released')
  },
)

it('does not repeat a restart reply when Telegram did not confirm its delivery', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  await ledger(server.harness, '42').change((data) => {
    data.restart = { chat: '7', message: '1', sender: '7', generation: 1 }
  })
  await server.close()
  bot.loseSendResponse()
  const next = await bot.reopen(server.host.ultimateRoot)
  await until(() =>
    next.system
      .current()
      .extensionDiagnostics.includes(
        'Telegram: restart reply delivery is uncertain. It will not be sent again automatically.',
      ),
  )
  expect(next.system.current().extensionDiagnostics).toContain(
    'Telegram: restart reply delivery is uncertain. It will not be sent again automatically.',
  )
  await next.close()
  await bot.reopen(server.host.ultimateRoot)
  bot.add(7, 2, '/help')
  await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
  expect(bot.sends.filter(({ text }) => text.startsWith('Restarted.'))).toHaveLength(1)
})

it('does not restart for an unapproved sender or a group', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const restart = vi.fn<typeof server.host.restart>()
  server.host.restart = restart
  bot.add(9, 1, '/restart')
  bot.add(7, 1, '/restart', 'group')
  bot.add(7, 2, '/help')
  await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
  expect(restart).not.toHaveBeenCalled()
  expect(bot.sends).toHaveLength(1)
})

it('requests restart even when Telegram rejects the initial reply', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const restart = vi.fn<typeof server.host.restart>(async () => 'Restart refused')
  server.host.restart = restart
  bot.rejectSendResponse()
  bot.add(7, 1, '/restart')
  await until(() => bot.sends.some(({ text }) => text === 'Restart failed: Restart refused'))
  expect(restart).toHaveBeenCalledOnce()
  expect(bot.sends.map(({ text }) => text)).toEqual([
    'Restarting…',
    'Restart failed: Restart refused',
  ])
})

it.each(['request', 'reply'] as const)(
  'reports a restart %s failure and continues polling',
  async (failure) => {
    const bot = await fixture()
    const server = await bot.reopen()
    const restart = vi.fn<typeof server.host.restart>(async () => {
      if (failure === 'request') throw new Error('Restart request failed')
      return 'Restart refused'
    })
    server.host.restart = restart
    if (failure === 'reply') bot.rejectSendResponse(2)
    bot.add(7, 1, '/restart')
    const warning = 'Telegram: restart failed. Check the host logs.'
    await until(() => server.system.current().extensionDiagnostics.includes(warning))
    bot.add(7, 2, '/help')
    await until(() => bot.sends.some(({ text }) => text.includes('/help: Show these commands')))
    expect(restart).toHaveBeenCalledOnce()
    expect(server.system.current().extensionDiagnostics).toContain(warning)
  },
)

it('renders model Markdown and splits long replies', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  const body = 'long '.repeat(900)
  server.host.faux!.setResponses([
    () =>
      fauxAssistantMessage(
        [
          '**Bold** and [link](https://example.com)',
          '```ts\nlet n = 1\n```',
          `${body}endword`,
        ].join('\n\n'),
      ),
  ])
  bot.add(7, 1, 'Format this')
  await until(async () =>
    Object.values((await durable.read()).deliveries).some((item) => item.status === 'sent'),
  )
  expect(bot.sends.length).toBeGreaterThan(1)
  expect(
    bot.sends.every(({ text, parse_mode }) => text.length <= 4096 && parse_mode === 'MarkdownV2'),
  ).toBe(true)
  const text = bot.sends.map((part) => part.text).join('\n')
  expect(text).toContain('*Bold* and [link](https://example.com)')
  expect(text).toContain('```ts\nlet n = 1\n```')
  expect(text.match(/\blong\b/g)).toHaveLength(900)
  expect(text).toMatch(/endword\s*$/)
})

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
    { chat_id: '7', text: 'Answer first', parse_mode: 'MarkdownV2' },
    { chat_id: '8', text: 'Answer second', parse_mode: 'MarkdownV2' },
  ])
  const saved = await durable.read()
  expect(Object.keys(saved.inputs).toSorted()).toEqual(['7:2', '8:1'])
  expect(bot.typing).not.toContain('9')
  expect(bot.reactions).toEqual([])
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
  const help = await command('/help', '/clear:')
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

it('refreshes typing across transient failures and removes the queue reaction when placed', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const next = Promise.withResolvers<void>()
  bot.setTypingMode('lose')
  server.host.faux!.setResponses([
    async () => {
      started.resolve()
      await release.promise
      return fauxAssistantMessage('First answer')
    },
    (request, options, modelState, model) => {
      next.resolve()
      return held(request, options, modelState, model)
    },
  ])
  try {
    bot.add(7, 1, 'Start a long turn')
    await started.promise
    await until(() => bot.typing.length === 2)
    bot.add(7, 2, '/followup Later')
    await until(() => bot.reactions.some((event) => event.message === 2 && event.emoji === '👍'))
    bot.add(7, 2, '/followup Later')
    bot.setTypingMode('rate')
    await until(() => bot.typing.length >= 4, 8_000)
    expect(bot.reactions).toEqual([{ chat: '7', message: 2, emoji: '👍' }])
    release.resolve()
    await next.promise
    await until(() => bot.reactions.some((event) => event.message === 2 && !event.emoji))
    expect(bot.reactions).toEqual([
      { chat: '7', message: 2, emoji: '👍' },
      { chat: '7', message: 2, emoji: undefined },
    ])
    bot.add(7, 3, '/stop')
    await until(() => bot.sends.some(({ text }) => text === 'Stopped the active run.'))
  } finally {
    release.resolve()
  }
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

it.each([false, true])(
  'keeps parallel tool calls in call order (edit failure: %s)',
  async (fail) => {
    const bot = await fixture()
    const server = await bot.reopen()
    const slow = Promise.withResolvers<void>()
    const fast = Promise.withResolvers<void>()
    server.host.registry.install(
      defineExtension({
        name: 'telegram-probe',
        tools: [
          defineTool({
            name: 'slow_probe',
            description: 'Wait for a test gate',
            parameters: obj({}),
            async execute() {
              await slow.promise
              return {}
            },
          }),
          defineTool({
            name: 'fast_probe',
            description: 'Report a test error',
            parameters: obj({}),
            async execute() {
              await fast.promise
              return { isError: true }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall('slow_probe', {}, { id: 'slow' }),
            fauxToolCall('fast_probe', {}, { id: 'fast' }),
          ],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Results ready'),
    ])
    try {
      bot.add(7, 1, 'Run the probes')
      await until(() =>
        [...bot.sends, ...bot.edits].some(
          ({ text }) =>
            text.includes('slow_probe · running') && text.includes('fast_probe · running'),
        ),
      )
      if (fail) bot.loseEditResponse()
      fast.resolve()
      await until(() =>
        bot.edits.some(
          ({ text }) =>
            text.includes('fast_probe · failed') && text.includes('slow_probe · running'),
        ),
      )
      const edited = bot.edits.find(({ text }) => text.includes('fast_probe · failed'))!
      expect(edited.text.split('\n')).toEqual([
        'Tool activity',
        'slow_probe · running',
        'fast_probe · failed',
      ])
      expect(edited.chat).toBe('7')
      slow.resolve()
      await until(() => bot.sends.some(({ text }) => text === 'Results ready'))
      if (!fail)
        await until(() =>
          bot.edits.some(
            ({ text }) =>
              text.includes('slow_probe · done') && text.includes('fast_probe · failed'),
          ),
        )
      expect(bot.edits.at(-1) === edited).toBe(fail)
      expect(bot.sends.filter(({ text }) => text.startsWith('Tool activity'))).toHaveLength(1)
      expect(new Set(bot.edits.map(({ message }) => message)).size).toBe(1)
    } finally {
      slow.resolve()
      fast.resolve()
    }
  },
)

it('excludes earlier web tools and shows fast sequential tools after a Telegram steer', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  const durable = ledger(server.harness, '42')
  bot.add(7, 1, '/new')
  await until(() => bot.sends.some(({ text }) => text === 'Started a fresh conversation.'))
  const id = (await durable.read()).chats['7'] as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  server.host.registry.install(
    defineExtension({
      name: 'telegram-sequential-probe',
      tools: [
        defineTool({
          name: 'web_probe',
          description: 'Wait for steer',
          parameters: obj({}),
          async execute() {
            started.resolve()
            await release.promise
            return {}
          },
        }),
        ...['first_probe', 'second_probe'].map((name) =>
          defineTool({
            name,
            description: 'Return promptly',
            parameters: obj({}),
            executionMode: 'sequential',
            execute: async () => ({}),
          }),
        ),
      ],
    }),
  )
  server.host.faux!.setResponses([
    () => fauxAssistantMessage([fauxToolCall('web_probe', {})], { stopReason: 'toolUse' }),
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall('first_probe', {}, { id: 'first' }),
          fauxToolCall('second_probe', {}, { id: 'second' }),
        ],
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage('Steer finished'),
  ])
  try {
    await conversation.submit({ type: 'input', content: 'Run from web' }, context)
    await started.promise
    expect(bot.typing).toEqual([])
    bot.add(7, 2, 'Do the next steps')
    await until(() => bot.reactions.some(({ message, emoji }) => message === 2 && emoji === '👍'))
    expect(bot.typing).toEqual([])
    expect(bot.sends.filter(({ text }) => text.startsWith('Tool activity'))).toEqual([])
    release.resolve()
    await until(() => bot.sends.some(({ text }) => text === 'Steer finished'))
    await until(() =>
      [...bot.sends, ...bot.edits].some(({ text }) =>
        text.includes('first_probe · done\nsecond_probe · done'),
      ),
    )
    expect([...bot.sends, ...bot.edits].some(({ text }) => text.includes('web_probe'))).toBe(false)
    expect(bot.sends.filter(({ text }) => text.startsWith('Tool activity'))).toHaveLength(1)
  } finally {
    release.resolve()
  }
})

it('sends committed assistant updates before tool progress and the final answer', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  server.host.registry.install(
    defineExtension({
      name: 'telegram-update-probe',
      tools: ['probe_a', 'probe_b', 'probe_c'].map((name) =>
        defineTool({
          name,
          description: 'Return promptly',
          parameters: obj({}),
          execute: async () => ({}),
        }),
      ),
    }),
  )
  server.host.faux!.setResponses([
    () =>
      fauxAssistantMessage([fauxText('Checking **first**'), fauxToolCall('probe_a', {})], {
        stopReason: 'toolUse',
      }),
    () =>
      fauxAssistantMessage([fauxThinking('SECRET_THINKING'), fauxToolCall('probe_b', {})], {
        stopReason: 'toolUse',
      }),
    () =>
      fauxAssistantMessage([fauxText('Checking second'), fauxToolCall('probe_c', {})], {
        stopReason: 'toolUse',
      }),
    () => fauxAssistantMessage('Final answer'),
  ])
  bot.add(7, 1, 'Work through it')
  await until(() => bot.sends.some(({ text }) => text === 'Final answer'))
  const texts = bot.sends.map(({ text }) => text)
  const order = ['Checking *first*', 'Tool activity', 'Checking second', 'Final answer'].map(
    (prefix) => texts.findIndex((text) => text.startsWith(prefix)),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  expect(texts.filter((text) => text.startsWith('Tool activity'))).toHaveLength(1)
  expect(texts.filter((text) => text === 'Final answer')).toHaveLength(1)
  expect(JSON.stringify([...bot.sends, ...bot.edits])).not.toContain('SECRET_THINKING')
})

it('sends an answer that continues the run before the final answer', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  let continued = false
  server.host.registry.install(
    defineExtension({
      name: 'telegram-yield-probe',
      hooks: [
        hook(GenerationTask, {
          onYield: () => {
            if (continued) return undefined
            continued = true
            return { continue: 'keep going' }
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    () => fauxAssistantMessage('Interim note'),
    () => fauxAssistantMessage('Final after yield'),
  ])
  bot.add(7, 1, 'Continue once')
  await until(() => bot.sends.some(({ text }) => text === 'Final after yield'))
  expect(bot.sends.map(({ text }) => text)).toEqual(['Interim note', 'Final after yield'])
})

it.each([false, true])(
  'does not resend an update that becomes the final answer (lost confirmation: %s)',
  async (lost) => {
    const bot = await fixture()
    const server = await bot.reopen()
    const durable = ledger(server.harness, '42')
    server.host.registry.install(
      defineExtension({
        name: 'telegram-terminate-probe',
        tools: [
          defineTool({
            name: 'finish_probe',
            description: 'End the run',
            parameters: obj({}),
            execute: async () => ({ control: { terminate: true as const } }),
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      () =>
        fauxAssistantMessage([fauxText('Done here'), fauxToolCall('finish_probe', {})], {
          stopReason: 'toolUse',
        }),
    ])
    if (lost) bot.loseSendResponse(1)
    bot.add(7, 1, 'Finish with a tool')
    await until(async () => (await durable.read()).inputs['7:1']?.settled === true)
    await server.close()
    const next = await bot.reopen(server.host.ultimateRoot)
    const after = ledger(next.harness, '42')
    bot.add(8, 1, 'next')
    await until(async () => (await after.read()).inputs['8:1']?.settled === true)
    expect(bot.sends.filter(({ text }) => text === 'Done here')).toHaveLength(1)
    expect(Object.values((await after.read()).deliveries).map(({ status }) => status)).toContain(
      lost ? 'uncertain' : 'sent',
    )
  },
)

it('shows Nanobot-style tool hints in Telegram', async () => {
  const bot = await fixture()
  const server = await bot.reopen()
  await writeFile(join(server.host.projectRoot, 'preview-note.md'), 'TOOL_OUTPUT_TEXT\n')
  server.host.faux!.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall('read', { path: 'preview-note.md' }, { id: 'note' }),
          fauxToolCall(
            'read',
            { path: '/opt/ultimate/extensions/telegram/README.md' },
            { id: 'long' },
          ),
          fauxToolCall('bash', { command: 'git status --short' }, { id: 'shell' }),
          fauxToolCall('web_fetch', { url: 'https://example.com/docs/page' }, { id: 'fetch' }),
          fauxToolCall(
            'codemode',
            { code: 'const files = await tools.read({ path: "a" })\nreturn files' },
            { id: 'code' },
          ),
          fauxToolCall(
            'mcp',
            { server: 'docs', tool: 'lookup', args: { query: 'pi durable' } },
            { id: 'mcp' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage('Preview done'),
  ])
  bot.add(7, 1, 'Preview tools')
  await until(() => bot.sends.some(({ text }) => text === 'Preview done'))
  const latest = () =>
    [...bot.sends, ...bot.edits].filter(({ text }) => text.startsWith('Tool activity')).at(-1)
      ?.text ?? ''
  await until(() => latest().split('\n').length === 7 && !/running|waiting/.test(latest()))
  const status = (label: string) =>
    expect.stringMatching(
      new RegExp('^' + label.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + ' · (done|failed)$'),
    )
  expect(latest().split('\n')).toEqual([
    'Tool activity',
    'read preview-note.md · done',
    status('read …/extensions/telegram/README.md'),
    status('$ git status --short'),
    status('fetch https://example.com/docs/page'),
    status('codemode("const files = await tools.read({ path: …")'),
    status('docs::lookup("pi durable")'),
  ])
  expect(JSON.stringify([...bot.sends, ...bot.edits])).not.toContain('TOOL_OUTPUT_TEXT')
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

it.each([1, 2])(
  'does not resend after restart when Telegram did not confirm part %s',
  async (part) => {
    const bot = await fixture()
    const server = await bot.reopen()
    const durable = ledger(server.harness, '42')
    bot.loseSendResponse(part)
    if (part > 1) server.host.faux!.setResponses([() => fauxAssistantMessage('long '.repeat(900))])
    bot.add(7, 1, 'once')
    await until(async () =>
      Object.values((await durable.read()).deliveries).some((item) => item.status === 'uncertain'),
    )
    expect(bot.sends).toHaveLength(part)
    await server.close()
    const next = await bot.reopen(server.host.ultimateRoot)
    const after = ledger(next.harness, '42')
    bot.add(7, 1, 'once')
    bot.add(8, 2, 'next')
    await until(async () => (await after.read()).inputs['8:2']?.settled === true)
    expect(bot.sends.filter(({ chat_id }) => chat_id === '7')).toHaveLength(part)
    expect((await after.read()).inputs['7:1']).toMatchObject({ settled: true })
  },
)

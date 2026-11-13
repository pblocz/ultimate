import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Profile } from '../shared/conversation-configuration.ts'
import { Metadata } from '../server/metadata.ts'
import { context } from '../server/harness.ts'
import { prepareFauxServer, sourceCopy, temp, removeTemp, until } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const definition = (body: string, tools = 'read, write') =>
  `---\nname: helper\ndescription: Ordinary helper\ntools: [${tools}]\nmodel: faux/faux-1\n---\n${body}\n`
async function fixture(onTool?: (file: string) => Promise<void>) {
  const home = await temp('ultimate-profile-prompt-')
  cleanup.push(() => removeTemp(home))
  const source = await sourceCopy(home)
  const projectRoot = join(home, 'workspace')
  const userHome = join(home, 'user')
  const probe = join(projectRoot, '.ultimate/extensions/profile-probe')
  await mkdir(probe, { recursive: true })
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { disable: ['dream', 'update', 'keep-warm', 'goal'] },
    }),
  )
  const file = join(userHome, '.ultimate/agents/helper.md')
  await writeFile(file, definition('Persona A instructions.'))
  await writeFile(join(projectRoot, 'shared.txt'), 'Shared file contents')
  await writeFile(
    join(probe, 'server.ts'),
    `
import { defineExtension } from '@earendil-works/pi-durable'
let port
export default host => {
  port = host.channelHost()
  return defineExtension({ name: 'profile-probe' })
}
export const actions = {
  create: input => port.conversations.create(input),
  configure: ({ id, change }) => port.conversations.configure(id, change),
}
`,
  )
  const server = await prepareFauxServer({
    ultimateRoot: source,
    projectRoot,
    userHome,
    home: join(home, 'state'),
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2', reasoning: true }] }),
  })
  cleanup.push(async () => {
    await server.vite.watcher.close()
    await server.close()
  })
  const requests: { system: string; role: string }[] = []
  const respond: FauxResponseFactory = async (request) => {
    server.host.faux!.appendResponses([respond])
    const last = request.messages.findLast((message) => message.role !== 'system')!
    requests.push({
      system: JSON.stringify(request.messages.filter((message) => message.role === 'system')),
      role: last.role,
    })
    if (last.role === 'toolResult') {
      await onTool?.(file)
      return fauxAssistantMessage('Read complete')
    }
    if (last.role === 'user' && last.content === 'READ_FILE')
      return fauxAssistantMessage([fauxToolCall('read', { path: 'shared.txt' })], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage('Answered')
  }
  server.host.faux!.setResponses([respond])
  const opened = await server.go()
  const invoke = (action: string, args: object) =>
    server.extensions.invoke('profile-probe', action, args as never, new AbortController().signal)
  const create = async (input: object = {}) =>
    (await invoke('create', input)) as { id: ConversationId }
  const ask = async (id: ConversationId, text: string) => {
    const conversation = (await opened.harness.conversation(id, context))!
    await (await conversation.submit({ type: 'input', content: text }, context)).wait(context)
  }
  return { server, opened, file, requests, create, ask, invoke }
}

it('composes selected instructions, refreshes only at the next turn, and retains model and tool choices', async () => {
  const f = await fixture((file) => writeFile(file, definition('Persona B instructions.', 'read')))
  const chat = await f.create({
    definition: 'helper',
    model: { provider: 'faux', modelId: 'faux-2' },
    thinkingLevel: 'high',
  })
  await f.ask(chat.id, 'READ_FILE')
  expect(f.requests).toHaveLength(2)
  for (const request of f.requests) {
    expect(request.system).toContain('Persona A instructions.')
    expect(request.system).not.toContain('Persona B instructions.')
    expect(request.system).not.toContain('You are Ultimate, a coding agent')
    // The helper has no `branch` tool, so the optional coding workflow adds nothing.
    expect(request.system).not.toContain('For coding work, build, verify, and report')
  }
  await f.ask(chat.id, 'Next turn')
  expect(f.requests.at(-1)!.system).toContain('Persona B instructions.')
  const agent = await (await f.opened.harness.conversation(chat.id, context))!.agent(context)
  expect(agent.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
  expect(agent.thinkingLevel).toBe('high')
  expect(agent.tools.map((tool) => tool.name)).toEqual(['read', 'write'])
  const entries = (
    await (await f.opened.harness.conversation(chat.id, context))!.entries(
      { order: 'ascending' },
      100,
      undefined,
      context,
    )
  ).items
  expect(
    entries.filter((entry) => entry.kind === 'pi.user').map((entry) => entry.model?.[0]?.content),
  ).toEqual(['READ_FILE', 'Next turn'])
})

it('uses a neutral prompt without a selected definition or a compulsory primary conversation', async () => {
  const f = await fixture()
  expect(f.requests).toEqual([])
  const chat = await f.create()
  await f.ask(chat.id, 'Hello')
  expect(f.requests.at(-1)!.system).toContain(
    'You are an assistant running in a durable agent runtime',
  )
  expect(f.requests.at(-1)!.system).not.toContain('You are Ultimate, a coding agent')
  // Coding text follows the coding workflow's `branch` tool, not a fixed primary conversation.
  const tools = (await (await f.opened.harness.conversation(chat.id, context))!.agent(context))
    .tools
  expect(f.requests.at(-1)!.system.includes('For coding work, build, verify, and report')).toBe(
    tools.some((tool) => tool.name === 'branch'),
  )
})

it('keeps a child instruction snapshot while the standalone conversation picks up definition edits', async () => {
  const f = await fixture()
  const chat = await f.create({ definition: 'helper' })
  await f.ask(chat.id, 'Parent history')
  const child = await f.opened.harness.commit(async (tx) => {
    const [at] = (await tx.scanEntries({ conversationId: chat.id }, 1)).items
    const fork = await tx.forkConversation(chat.id, at.id, { ownership: { kind: 'ownerless' } })
    ;(await tx.doc(Profile, fork.id)).definition = 'helper'
    // The label alone would allow a refresh; the fork's history parent keeps its snapshot.
    ;(await tx.doc(Metadata, fork.id)).label = 'chat'
    return fork
  }, context)
  await writeFile(f.file, definition('Persona B instructions.'))
  await f.ask(child.id, 'Child turn')
  expect(f.requests.at(-1)!.system).toContain('Persona A instructions.')
  expect(f.requests.at(-1)!.system).not.toContain('Persona B instructions.')
  await f.ask(chat.id, 'Parent turn')
  expect(f.requests.at(-1)!.system).toContain('Persona B instructions.')
})

it('keeps the effective configuration when a selected definition becomes invalid', async () => {
  const f = await fixture()
  const chat = await f.create({ definition: 'helper' })
  await f.ask(chat.id, 'First turn')
  await writeFile(f.file, 'Invalid definition text')
  await until(
    async () =>
      (
        (await f.server.extensions.invoke(
          'subagents',
          'definitions',
          null,
          new AbortController().signal,
        )) as { errors: unknown[] }
      ).errors.length > 0,
  )
  await f.ask(chat.id, 'Keep the selected configuration')
  expect(f.requests.at(-1)!.system).toContain('Persona A instructions.')
  expect(await f.opened.harness.snapshot(Profile, chat.id, context)).toEqual({
    definition: 'helper',
  })
})

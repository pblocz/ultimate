import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Family } from '../../extensions/models/api.ts'
import { Profile, Standing } from '../../extensions/subagents/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps admitted work on the old ID and routes future named deliveries to the replacement', async () => {
  const home = await temp('ultimate-clear-routing-')
  cleanup.push(() => removeTemp(home))
  const workspace = join(home, 'workspace')
  const user = join(home, 'user')
  const agents = join(user, '.ultimate/agents')
  const probe = join(workspace, '.ultimate/extensions/clear-probe')
  await mkdir(agents, { recursive: true })
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(user, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: {
        disable: ['coding-workflow', 'supercoordinator', 'dream', 'telegram', 'update'],
      },
    }),
  )
  await writeFile(
    join(agents, 'research.md'),
    '---\nname: research\ndescription: Test resident\nresident: true\n---\nResearch instructions.\n',
  )
  await writeFile(
    join(probe, 'server.ts'),
    `
    import { defineExtension } from '@earendil-works/pi-durable'
    import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
    import { MessagesApi } from ${JSON.stringify(resolve('extensions/messages/api.ts'))}
    export default () => defineExtension({ name: 'clear-probe' })
    export const actions = {
      send: ({ to, text }, { host }) => host.need(MessagesApi).send('user', { to, text, reply: false }, undefined, context),
      clearAsAgent: ({ id }, { host, signal }) => host.invoke('subagents', 'clearConversation', { id }, signal, id),
    }
  `,
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: workspace,
    userHome: user,
    home: join(home, 'state'),
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-selected', reasoning: true }] }),
  })
  cleanup.push(() => server.close())
  const action = (name: string, args: unknown) =>
    post(server, `/api/extensions/${name.replace('.', '/actions/')}`, { args })
  const old = (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.research
  const model = { provider: 'faux', modelId: 'faux-selected' }
  await server.harness.commit(async (tx) => {
    await configure(tx, old, { model, thinkingLevel: 'low' })
    ;(await tx.doc(Family, old)).name = null
  }, context)
  const conversation = (await server.harness.conversation(old, context))!
  const entries = async (id: ConversationId) =>
    (await (await server.harness.conversation(id, context))!.context(context)).entries
  const textOf = (content: unknown) =>
    typeof content === 'string' ? content : JSON.stringify(content ?? '')
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const respond: FauxResponseFactory = async (request) => {
    server.host.faux!.appendResponses([respond])
    const text = textOf(request.messages.findLast(({ role }) => role === 'user')?.content)
    if (text.includes('held before clear')) {
      started.resolve()
      await release.promise
      return fauxAssistantMessage('Finished in the old conversation')
    }
    return fauxAssistantMessage('Received by the target')
  }
  server.host.faux!.setResponses([respond])
  try {
    const input = await conversation.submit(
      { type: 'input', content: 'held before clear' },
      context,
    )
    await started.promise
    const queued = await conversation.submit(
      { type: 'input', content: 'queued before clear', whenBusy: 'followUp' },
      context,
    )
    expect((await queued.status(context)).status).toBe('queued')
    const oldHistory = await entries(old)
    const rejectsAgent = await action('clear-probe.clearAsAgent', { id: old })
    expect(rejectsAgent.status).not.toBe(200)
    expect((await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.research).toBe(
      old,
    )
    const clear = await action('subagents.clearConversation', { id: old })
    expect([clear.status, clear.data.error]).toEqual([200, undefined])
    const fresh = clear.data.result as ConversationId
    expect(fresh).not.toBe(old)
    expect(await entries(old)).toEqual(oldHistory)
    expect(await entries(fresh)).toEqual([])
    expect(await server.harness.snapshot(Profile, fresh, context)).toEqual({
      definition: 'research',
    })
    const selected = (await server.harness.conversation(fresh, context))!
    expect(await selected.agent(context)).toMatchObject({
      model,
      thinkingLevel: 'low',
      instructions: 'Research instructions.',
    })
    expect((await input.status(context)).status).toBe('placed')
    expect((await queued.status(context)).status).toBe('queued')

    for (const [to, text] of [
      ['@research', 'named message after clear'],
      [`#${old}`, 'fixed message after clear'],
    ]) {
      const sent = await action('clear-probe.send', { to, text })
      expect([sent.status, sent.data.error]).toEqual([200, undefined])
    }
    for (const [name, subscribers] of [
      ['Named delivery', ['@research']],
      ['Fixed delivery', [old]],
    ] as const) {
      const created = await action('automations.create', {
        name,
        subscribers,
        schedule: 'every 1d',
      })
      expect([created.status, created.data.error]).toEqual([200, undefined])
      const run = await action('automations.run', { id: created.data.result.id })
      expect([run.status, run.data.error]).toEqual([200, undefined])
    }
    await until(async () => (await entries(fresh)).some(({ kind }) => kind === 'automations.fired'))
    await until(
      async () => ((await server.harness.snapshot(InboxDoc, old, context))?.items.length ?? 0) >= 3,
    )
    release.resolve()
    expect(await input.wait(context)).toMatchObject({ status: 'done', conversationId: old })
    expect(await queued.wait(context)).toMatchObject({ status: 'done', conversationId: old })
    await conversation.waitForIdle(context)
    await selected.waitForIdle(context)
    const latest = JSON.stringify(await entries(fresh))
    const original = JSON.stringify(await entries(old))
    expect(latest).toContain('named message after clear')
    expect(original).toContain('fixed message after clear')
    expect(original).toContain('Finished in the old conversation')
    expect(latest).not.toMatch(/fixed message after clear|held before clear|queued before clear/)
    expect(original).not.toContain('named message after clear')
    expect(
      (await entries(fresh))
        .filter(({ kind }) => kind === 'automations.fired')
        .map(({ data }) => data),
    ).toEqual([expect.objectContaining({ name: 'Named delivery' })])
    expect(
      (await entries(old))
        .filter(({ kind }) => kind === 'automations.fired')
        .map(({ data }) => data),
    ).toEqual([expect.objectContaining({ name: 'Fixed delivery' })])
    expect(await selected.agent(context)).toMatchObject({ model, thinkingLevel: 'low' })
  } finally {
    release.resolve()
  }
})

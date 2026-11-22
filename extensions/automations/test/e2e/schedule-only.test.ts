import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '@ultimate/server/harness.ts'
import { prepareFauxServer, sourceCopy, temp, until } from '@ultimate/test/helpers.ts'
import { Standing } from '@ultimate/ext/subagents/api.ts'
import { Automations } from '../../server.ts'
import type { Automation } from '../../types.ts'

const servers: Awaited<ReturnType<typeof prepareFauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
})

it('runs and recovers ordinary schedules with the supervisor file absent', async () => {
  const root = await temp('ultimate-schedule-only-')
  const source = await sourceCopy(root)
  const project = join(root, 'project')
  const userHome = join(root, 'user')
  await mkdir(project)
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: { disable: ['coding-workflow', 'dream', 'goal', 'update'] },
    }),
  )
  for (const path of [
    'extensions/automations/supervisor.ts',
    'extensions/automations/agents/watcher.md',
    'extensions/coding-workflow/agents/ultimate.md',
  ])
    await rm(join(source, path))
  const server = await prepareFauxServer({
    ultimateRoot: source,
    projectRoot: project,
    userHome,
    home: join(root, 'state'),
    localSetup: false,
  })
  servers.push(server)
  const answer: FauxResponseFactory = () => {
    server.host.faux!.appendResponses([answer])
    return fauxAssistantMessage('Scheduled work complete')
  }
  server.host.faux!.setResponses([answer])
  let opened = await server.go()
  const subscriber = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const agent = await opened.root.agent(context)
  await opened.harness.commit(
    (tx) => configure(tx, subscriber.id, { model: agent.model, tools: [] }),
    context,
  )
  const invoke = (action: string, args: { [key: string]: string | number[] }) =>
    server.extensions.invoke(
      'automations',
      action,
      args,
      new AbortController().signal,
      subscriber.id,
    )
  const a = (await invoke('create', {
    name: 'Ordinary schedule',
    schedule: 'every 1h',
    prompt: 'Check the shared workspace',
    subscribers: [subscriber.id],
  })) as Automation
  await invoke('pause', { id: a.id })
  expect((await opened.harness.snapshot(Automations, context))!.automations[a.id].enabled).toBe(
    false,
  )
  await invoke('resume', { id: a.id })
  await invoke('run', { id: a.id })
  await until(async () =>
    (await opened.harness.snapshot(Automations, context))!.automations[a.id].runs.some(
      (run) => run.status === 'done',
    ),
  )
  for (let i = 0; i < 6; i++) await invoke('run', { id: a.id })
  await until(async () =>
    (await subscriber.context(context)).entries.some(
      (entry) => entry.kind === 'automations.escalated',
    ),
  )
  const before = (await opened.harness.snapshot(Automations, context))!.automations[a.id]
  expect(before).toMatchObject({ fires: 6, enabled: false })
  expect(before.script).toBeUndefined()
  expect(
    (await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate,
  ).toBeUndefined()
  await expect(
    server.extensions.invoke(
      'automations',
      'create',
      {
        name: 'Unsupported script',
        ask: 'Watch a process',
      },
      new AbortController().signal,
      subscriber.id,
    ),
  ).rejects.toThrow('Script automation support is not available')
  expect(Object.keys((await opened.harness.snapshot(Automations, context))!.automations)).toEqual([
    a.id,
  ])
  await expect(access(join(source, 'extensions/automations/supervisor.ts'))).rejects.toThrow(
    'ENOENT',
  )
  await expect(access(join(project, '.git'))).rejects.toThrow('ENOENT')
  const pending = (await invoke('create', {
    name: 'Pending schedule',
    schedule: 'every 1d',
    subscribers: [subscriber.id],
  })) as Automation
  const legacyWatcher = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await opened.harness.commit(async (tx) => {
    const legacy: Automation = {
      ...before,
      id: 'A99',
      runs: [],
      script: {
        ask: 'Stored script',
        once: true,
        state: 'stopped',
        conversationId: legacyWatcher.id,
      },
    }
    delete legacy.schedule
    ;(await tx.doc(Automations)).automations[legacy.id] = legacy
  }, context)
  await subscriber.waitForIdle(context)
  await server.release()
  // Configure responses before the native scheduler and pending work resume.
  server.host.faux!.setResponses([answer])
  opened = await server.go()
  const recovered = (await opened.harness.snapshot(Automations, context))!.automations
  expect(recovered[a.id]).toMatchObject({ fires: 6, enabled: false })
  expect(recovered.A99.script).toMatchObject({ ask: 'Stored script', state: 'stopped' })
  expect(recovered[pending.id].enabled).toBe(true)
  await invoke('run', { id: pending.id })
  const recipient = (await opened.harness.conversation(subscriber.id, context))!
  await until(async () =>
    (await recipient.context(context)).entries.some(
      (entry) =>
        entry.kind === 'automations.fired' && (entry.data as { id?: string }).id === pending.id,
    ),
  )
  await invoke('pause', { id: pending.id })
  await invoke('resume', { id: a.id })
  expect((await opened.harness.snapshot(Automations, context))!.automations[a.id].enabled).toBe(
    true,
  )
  await invoke('pause', { id: a.id })
})

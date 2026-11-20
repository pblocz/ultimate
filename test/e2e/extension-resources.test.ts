import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../../server/harness.ts'
import { post, prepareFauxServer, removeTemp, temp, until } from '../helpers.ts'
import { ordinarySource } from '../ordinary-web-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('discovers extension resources through public interfaces and retains existing automation behavior after disable and removal', async () => {
  const home = await temp('ultimate-extension-resources-')
  cleanup.push(() => removeTemp(home))
  const source = await ordinarySource(join(home, 'source'))
  const workspace = join(home, 'workspace')
  const userHome = join(home, 'user')
  const folder = join(workspace, '.ultimate/extensions/resource-probe')
  await mkdir(join(folder, 'skills/resource-probe'), { recursive: true })
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  await writeFile(
    join(folder, 'skills/resource-probe/SKILL.md'),
    '---\nname: resource-probe\ndescription: Resource probe summary\n---\nRESOURCE_SKILL_BODY\n',
  )
  await writeFile(
    join(folder, 'server.ts'),
    `import { defineExtension, defineTool, GenerationTask, hook } from '@earendil-works/pi-durable'
import { obj } from '@earendil-works/pi-schema'
import { AutomationsApi } from ${JSON.stringify(join(source, 'extensions/automations/api.ts'))}
export default function resourceProbe() {
  return defineExtension({
    name: 'resource-probe',
    tools: [defineTool({
      name: 'resource_probe', description: 'Resource probe tool', parameters: obj({}), replay: 'safe',
      execute: async () => ({ output: [{ type: 'text', text: 'RESOURCE_TOOL_RESULT' }] }),
    })],
    hooks: [hook(GenerationTask, {
      beforeInput: async () => ({ entries: [{
        kind: 'resource-probe.note', data: {},
        model: [{ role: 'user', content: 'RESOURCE_HOOK', timestamp: 1 }],
      }] }),
    })],
  })
}
export const actions = {
  install: async ({ to }, { host }) => host.need(AutomationsApi).create({
    name: 'Resource probe automation', key: 'resource-probe',
    schedule: { kind: 'at', time: '2099-01-01T00:00:00Z' }, subscribers: [to],
  }),
}
`,
  )
  const server = await prepareFauxServer({
    ultimateRoot: source,
    projectRoot: workspace,
    userHome,
    home: join(home, 'state'),
    localSetup: false,
  })
  cleanup.push(async () => {
    await server.vite.watcher.close()
    await server.close()
  })
  const systems: string[] = []
  const messages: string[] = []
  let callTool = false
  const respond: FauxResponseFactory = (request) => {
    server.host.faux!.appendResponses([respond])
    systems.push(JSON.stringify(request.messages.filter((message) => message.role === 'system')))
    messages.push(JSON.stringify(request.messages.filter((message) => message.role !== 'system')))
    if (callTool) {
      callTool = false
      return fauxAssistantMessage([fauxToolCall('resource_probe', {})], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage('Resource answer')
  }
  server.host.faux!.setResponses([respond])
  const opened = await server.go()
  const action = (extension: string, name: string, args: object = {}) =>
    post(server, `/api/extensions/${extension}/actions/${name}`, { args })
  const newChat = async () => {
    const created = await post(server, '/api/conversations')
    expect(created.status).toBe(201)
    return created.data.id as ConversationId
  }
  const ask = async (id: ConversationId, text: string) => {
    const submitted = await post(server, `/api/conversations/${id}/submit`, { text })
    expect(submitted.status).toBe(202)
    const submission = (await opened.harness.submission(submitted.data.submissionId, context))!
    await submission.wait(context)
  }
  const listedSkill = () => opened.system.current().skills.find((s) => s.name === 'resource-probe')
  const listed = async () => {
    const response = await action('automations', 'list')
    expect(response.status).toBe(200)
    return response.data.result as { id: string; enabled: boolean; fires: number }[]
  }

  // Neither executable configuration nor its skills load before workspace trust.
  expect(server.extensions.info().find((e) => e.name === 'resource-probe')).toMatchObject({
    enabled: false,
  })
  expect(listedSkill()).toBeUndefined()
  const untrusted = await newChat()
  await ask(untrusted, 'Before trust')
  const neutral = systems.at(-1)!
  for (const text of [
    '<principles>',
    '<self>',
    'git log',
    'git status',
    '@ultimate',
    'resource_probe',
  ])
    expect(neutral).not.toContain(text)
  expect(neutral).toContain('You are an assistant running in a durable agent runtime')
  expect(await listed()).toEqual([])

  expect((await action('onboarding', 'decide', { local: true })).status).toBe(200)
  await until(() => listedSkill()?.extension === 'resource-probe')
  expect(listedSkill()).toMatchObject({
    scope: 'extension',
    extension: 'resource-probe',
    description: 'Resource probe summary',
  })
  const active = await newChat()
  const installed = await action('resource-probe', 'install', { to: active })
  expect(installed.status).toBe(200)
  const automationId = installed.data.result.id as string
  expect(installed.data.result).toMatchObject({ enabled: true, fires: 0 })
  callTool = true
  await ask(active, 'Call the resource tool')
  expect(systems.at(-1)).toContain('resource_probe')
  expect(systems.at(-1)).toContain('<name>resource-probe</name>')
  expect(systems.at(-1)).not.toContain('RESOURCE_SKILL_BODY')
  expect(messages.at(-1)).toContain('RESOURCE_HOOK')
  expect(messages.at(-1)).toContain('RESOURCE_TOOL_RESULT')
  await ask(active, '/skill:resource-probe argument')
  expect(messages.at(-1)).toContain('RESOURCE_SKILL_BODY')

  expect(
    (
      await action('onboarding', 'setExtension', {
        name: 'resource-probe',
        enabled: false,
        scope: 'project',
      })
    ).status,
  ).toBe(200)
  await until(() => listedSkill() === undefined)
  const disabled = await newChat()
  await ask(disabled, '/skill:resource-probe')
  expect(systems.at(-1)).not.toContain('resource_probe')
  expect(systems.at(-1)).not.toContain('<name>resource-probe</name>')
  expect(messages.at(-1)).not.toContain('RESOURCE_HOOK')
  expect(messages.at(-1)).not.toContain('RESOURCE_SKILL_BODY')
  expect(messages.at(-1)).toContain('/skill:resource-probe')
  expect(await listed()).toEqual([expect.objectContaining({ id: automationId, enabled: true })])
  // Unloading an extension does not pause the automation it created. No ownership policy is added.
  const fire = async (count: number) => {
    const before = messages.length
    expect((await action('automations', 'run', { id: automationId })).status).toBe(200)
    await until(async () => (await listed())[0]?.fires === count)
    await until(
      async () =>
        messages.length > before && !(await opened.harness.snapshot(LiveDoc, active, context))?.run,
    )
  }
  await fire(1)

  // Reactivation restores the resources, but does not expand the old chat's history retroactively.
  expect(
    (
      await action('onboarding', 'setExtension', {
        name: 'resource-probe',
        enabled: true,
        scope: 'project',
      })
    ).status,
  ).toBe(200)
  await until(() => listedSkill() !== undefined)
  const reactivated = await newChat()
  await ask(reactivated, 'After reactivation')
  expect(systems.at(-1)).toContain('<name>resource-probe</name>')
  expect(messages.at(-1)).toContain('RESOURCE_HOOK')

  await rm(folder, { recursive: true })
  await until(() => !server.extensions.info().some((e) => e.name === 'resource-probe'))
  await until(() => listedSkill() === undefined)
  const removed = await newChat()
  await ask(removed, '/skill:resource-probe')
  expect(systems.at(-1)).not.toContain('resource_probe')
  expect(systems.at(-1)).not.toContain('<name>resource-probe</name>')
  expect(messages.at(-1)).not.toContain('RESOURCE_HOOK')
  expect(messages.at(-1)).not.toContain('RESOURCE_SKILL_BODY')
  expect(await listed()).toEqual([
    expect.objectContaining({ id: automationId, enabled: true, fires: 1 }),
  ])
  await fire(2)
  expect(server.extensions.catalogue()).toMatchObject({ missing: [], cycles: [] })
})

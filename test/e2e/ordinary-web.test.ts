// Phase 3: the ordinary web application runs without the coding modules. A new page opens on the empty new-chat screen,
// creates no primary agent and sends no model request; two chats share one persona, run on different presets, share
// files and keep separate histories; the selection survives a reload; settings and provider controls open.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Standing } from '../../extensions/subagents/api.ts'
import { writeFamilies } from '../../lib/families-settings.ts'
import { context } from '../../server/harness.ts'
import { Family, Profile } from '../../shared/conversation-configuration.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'
import { omittedExtensions, ordinaryExtensions, ordinarySource } from '../ordinary-web-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const text = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: { text?: string }) => block.text ?? '').join('')
      : ''

it('creates and uses two independent persona chats on different presets without the coding modules', async () => {
  const home = await temp('ultimate-ordinary-web-')
  cleanup.push(() => removeTemp(home))
  const userHome = join(home, 'user')
  const projectRoot = join(home, 'workspace')
  const source = await ordinarySource(join(home, 'source'))
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  await writeFile(
    join(userHome, '.ultimate/agents/helper.md'),
    '---\nname: helper\ndescription: Ordinary helper\ntools: [read, write]\n---\nYou are the ordinary helper persona.\n',
  )
  await writeFamilies(userHome, projectRoot, {
    families: {
      quick: { model: 'faux/faux-1', thinking: 'off' },
      deliberate: { model: 'faux/faux-2', thinking: 'high' },
    },
  })
  const requests: { model: string; system: string; transcript: string }[] = []
  const respond: FauxResponseFactory = (request, _options, _state, model) => {
    server.host.faux!.appendResponses([respond])
    requests.push({
      model: model.id,
      system: JSON.stringify(request.messages.filter((message) => message.role === 'system')),
      transcript: JSON.stringify(request.messages.filter((message) => message.role !== 'system')),
    })
    const last = request.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'toolResult')
      return fauxAssistantMessage(`Done on ${model.id}: ${text(last.content)}`)
    const asked = text(last.content)
    return fauxAssistantMessage(
      [
        asked.includes('Write')
          ? fauxToolCall('write', { path: 'shared.txt', content: 'from chat A' })
          : fauxToolCall('read', { path: 'shared.txt' }),
      ],
      { stopReason: 'toolUse' },
    )
  }
  const server = await fauxServer({
    ultimateRoot: source,
    projectRoot,
    userHome,
    home: join(home, 'state'),
    port: 0,
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2', reasoning: true }] }),
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses([respond])

  // Only the inventory loaded, from the copy; nothing that needs a missing service, no cycle, no build error.
  const extensions = server.system.current().extensions
  const loaded = extensions.map((extension) => extension.name)
  expect(loaded.toSorted()).toEqual(ordinaryExtensions.toSorted())
  // Every server facet loaded: a module that fails to evaluate records its error here, not in the diagnostics.
  expect(
    extensions.flatMap((extension) =>
      extension.facets.server && (!extension.server?.loadedAt || extension.server.error)
        ? [`${extension.name}: ${extension.server?.error ?? 'not loaded'}`]
        : [],
    ),
  ).toEqual([])
  for (const name of omittedExtensions) expect(loaded).not.toContain(name)
  expect(server.extensions.catalogue().missing).toEqual([])
  expect(server.extensions.catalogue().cycles).toEqual([])
  expect(server.system.current().extensionDiagnostics).toEqual([])
  const original = resolve('extensions') + '/'
  expect(
    [...server.vite.environments.ssr.moduleGraph.idToModuleMap.keys()].filter((id) =>
      id.startsWith(original),
    ),
  ).toEqual([])

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(server.url)
  await page.locator('[data-ui="no-conversation"]').waitFor()
  expect(server.system.current().web.error).toBeUndefined()
  // Opening the page created no conversation and asked no model.
  expect(requests).toEqual([])
  expect(server.api.conversations().filter((summary) => summary.label === 'chat')).toEqual([])
  expect(
    (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate,
  ).toBeUndefined()

  const shown = () => new URL(page.url()).searchParams.get('conversation')
  const chat = async (preset: 'Quick' | 'Deliberate', prompt: string) => {
    const before = shown()
    await page
      .getByRole('navigation', { name: 'Ordinary conversations' })
      .getByRole('button', { name: 'New conversation' })
      .click()
    // The new chat, not the one shown before it.
    await until(() => shown() !== null && shown() !== before)
    const id = Number(shown())
    await choosePersona(page)
    await page.locator('#app button[title$="pick a model"]').click()
    await page
      .locator(`[data-slot="command-item"][data-value="family/${preset.toLowerCase()}"]`)
      .click()
    await until(
      async () =>
        (await server.harness.snapshot(Family, id as ConversationId, context))?.name ===
        preset.toLowerCase(),
    )
    // The picker closes once its request resolved; until then Enter would pick again instead of sending.
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const composer = page.locator(`#app [data-ui="composer"] textarea[data-conversation="${id}"]`)
    await composer.fill(prompt)
    await composer.press('Enter')
    return id
  }

  const left = await chat('Quick', 'Write the shared note')
  await page.locator('#app').getByText('Done on faux-1:').waitFor()
  const right = await chat('Deliberate', 'Read the shared note')
  await page.locator('#app').getByText('Done on faux-2:').waitFor()
  expect(left).not.toBe(right)

  // Shared workspace, separate histories, one persona on two presets.
  expect(await readFile(join(projectRoot, 'shared.txt'), 'utf8')).toBe('from chat A')
  expect(requests.map((request) => request.model)).toEqual(['faux-1', 'faux-1', 'faux-2', 'faux-2'])
  expect(requests.at(-1)!.transcript).toContain('from chat A')
  for (const request of requests.slice(2))
    expect(request.transcript).not.toContain('Write the shared note')
  for (const request of requests) {
    expect(request.system).toContain('You are the ordinary helper persona.')
    expect(request.system).not.toContain('You are Ultimate, a coding agent')
  }
  for (const [id, preset] of [
    [left, 'quick'],
    [right, 'deliberate'],
  ] as const) {
    expect(await server.harness.snapshot(Profile, id as ConversationId, context)).toEqual({
      definition: 'helper',
    })
    expect((await server.harness.snapshot(Family, id as ConversationId, context))?.name).toBe(
      preset,
    )
  }
  expect(
    (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate,
  ).toBeUndefined()

  // The selection survives a reload, and the list shows both chats with the selected one current.
  await page.reload()
  await page.locator('#app [data-ui="composer"] textarea').waitFor()
  expect(new URL(page.url()).searchParams.get('conversation')).toBe(String(right))
  await page
    .locator(`#app [data-ui="ordinary-row"][data-conversation="${right}"][aria-current="page"]`)
    .waitFor()
  await page.locator(`#app [data-ui="ordinary-row"][data-conversation="${left}"]`).waitFor()

  // Generic settings and provider controls open without starting a model turn.
  const before = requests.length
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('Run a command…').fill('Extensions')
  await page.locator('[data-slot="command-item"]', { hasText: 'Extensions…' }).click()
  await page
    .locator('#app')
    .getByText(/saved in .*settings\.json/)
    .waitFor()
  await page.locator('#app button[title$="pick a model"]').click()
  await page.locator('[data-slot="command-item"][data-value="login"]').click()
  await page.getByRole('dialog', { name: 'Log in to a provider' }).waitFor()
  expect(requests).toHaveLength(before)
  expect(
    (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate,
  ).toBeUndefined()
})

async function choosePersona(page: Page) {
  // Scoped to the app: after a reload, #resume holds a static copy of the last view.
  const persona = page.locator('#app').getByRole('button', { name: 'Persona' })
  await persona.click()
  await page.locator('button[title="Ordinary helper"]').click()
  await persona.filter({ hasText: 'helper' }).waitFor()
  // The popover closes once its request resolved; an earlier click elsewhere would only close it.
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}

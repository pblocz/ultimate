import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Standing } from '../../extensions/subagents/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** A server with resident definitions `residents` and extensions `disable` off, and a page on it. */
async function start(disable: string[], residents: string[]) {
  const home = await temp('ultimate-clear-web-')
  cleanup.push(() => removeTemp(home))
  const userHome = join(home, 'user')
  const projectRoot = join(home, 'workspace')
  await mkdir(projectRoot)
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { disable } }),
  )
  for (const name of residents)
    await writeFile(
      join(userHome, `.ultimate/agents/${name}.md`),
      `---\nname: ${name}\ndescription: Test resident\nresident: true\n---\nTest instructions.\n`,
    )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    userHome,
    projectRoot,
    home: join(home, 'state'),
  })
  cleanup.push(() => server.close())
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const shown = () => new URL(page.url()).searchParams.get('conversation')
  // A resumed view mounts its own root too: the shell keeps the booted app, so its button is the one to press. The
  // palette itself renders in a portal outside both roots.
  const menu = () =>
    page.locator('#app').getByRole('button', { name: 'Command palette', exact: true }).click()
  const command = (id: string) => page.locator(`[data-ui="palette"] [data-value$=" ${id}"]`)
  const standing = async () =>
    (await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!
  const clear = async (id: number) => {
    await menu()
    await command('agent.clear').click()
    await until(() => shown() !== null && Number(shown()) !== id)
    return Number(shown())
  }
  /** Whether the palette offers Clear conversation for the shown conversation. */
  const offered = async () => {
    await menu()
    await command('ultimate.new').waitFor()
    const count = await command('agent.clear').count()
    await page.keyboard.press('Escape')
    return count > 0
  }
  return { server, page, shown, menu, command, standing, clear, offered }
}

it('clears the open conversation without moving unrelated addresses', async () => {
  const { server, page, shown, menu, command, standing, clear } = await start(
    ['coding-workflow', 'supercoordinator', 'dream', 'telegram', 'update'],
    ['ultimate', 'research'],
  )
  const initial = await standing()
  expect(initial).toEqual({ ultimate: expect.any(Number), research: expect.any(Number) })
  await page.goto(server.url)
  await page.locator('[data-ui="no-conversation"]').waitFor()
  await menu()
  await command('ultimate.new').waitFor()
  expect(await command('agent.clear').count()).toBe(0)
  await command('ultimate.new').click()
  await until(() => shown() !== null)
  const ordinary = Number(shown())
  expect(await standing()).toEqual(initial)
  expect(await clear(ordinary)).not.toBe(ordinary)
  expect(await standing()).toEqual(initial)

  await page.goto(`${server.url}/?conversation=${initial.ultimate}`)
  const ultimate = await clear(initial.ultimate)
  expect(await standing()).toEqual({ ultimate, research: initial.research })
  await page.goto(`${server.url}/?conversation=${initial.research}`)
  const research = await clear(initial.research)
  expect(await standing()).toEqual({ ultimate, research })
  expect(server.conversations().map(({ id }) => id)).toEqual(
    expect.arrayContaining([ordinary, initial.ultimate, initial.research, ultimate, research]),
  )
})

it('moves a cleared standing agent out of the Agents group and stops offering to clear it', async () => {
  // `@ultimate` is reserved by the supercoordinator and has no conversation until it is opened: clear two plain ones.
  const { server, page, standing, clear, offered } = await start(
    ['supercoordinator', 'dream', 'telegram', 'update'],
    ['research', 'notes'],
  )
  const initial = await standing()
  expect(initial).toEqual({ research: expect.any(Number), notes: expect.any(Number) })
  const agents = page.getByRole('group', { name: 'Agents' })
  const row = (id: number) => page.locator(`[data-ui="sidebar-row"][data-conversation="${id}"]`)
  const inAgents = (id: number) => agents.locator(`[data-conversation="${id}"]`)

  await page.goto(`${server.url}/?conversation=${initial.research}`)
  await inAgents(initial.research).waitFor()
  const research = await clear(initial.research)
  expect(await standing()).toEqual({ research, notes: initial.notes })
  await inAgents(research).waitFor()
  await expect.poll(() => inAgents(initial.research).count()).toBe(0)

  await page.goto(`${server.url}/?conversation=${initial.notes}`)
  await inAgents(initial.notes).waitFor()
  const notes = await clear(initial.notes)
  expect(await standing()).toEqual({ research, notes })
  await inAgents(notes).waitFor()
  await expect.poll(() => inAgents(initial.notes).count()).toBe(0)

  // The old conversations keep their history and their `agent` label, as ordinary rows under Earlier.
  for (const id of [initial.research, initial.notes])
    expect(server.conversations().find((conversation) => conversation.id === id)?.label).toBe(
      'agent',
    )
  await page.getByText(/^Earlier \u00b7 /).click()
  const earlier = page.getByRole('region', { name: 'Earlier' })
  await earlier.locator(`[data-conversation="${initial.research}"]`).waitFor()
  await earlier.locator(`[data-conversation="${initial.notes}"]`).waitFor()

  // Only the conversation an address points to can be cleared.
  await page.goto(`${server.url}/?conversation=${initial.research}`)
  await row(initial.research).waitFor()
  await until(async () => !(await offered()))
  await page.goto(`${server.url}/?conversation=${research}`)
  await until(async () => offered())
})

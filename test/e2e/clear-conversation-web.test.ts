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

it('clears the open conversation without moving unrelated addresses', async () => {
  const home = await temp('ultimate-clear-web-')
  cleanup.push(() => removeTemp(home))
  const userHome = join(home, 'user')
  const projectRoot = join(home, 'workspace')
  await mkdir(projectRoot)
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { disable: ['coding-workflow', 'dream', 'telegram', 'update'] },
    }),
  )
  for (const name of ['ultimate', 'research'])
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
  const standing = () => server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  const initial = (await standing())!
  expect(initial).toEqual({ ultimate: expect.any(Number), research: expect.any(Number) })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const shown = () => new URL(page.url()).searchParams.get('conversation')
  const menu = () => page.getByRole('button', { name: 'Command palette', exact: true }).click()
  const command = (id: string) => page.locator(`[data-ui="palette"] [data-value$=" ${id}"]`)
  async function clear(id: number) {
    await menu()
    await command('agent.clear').click()
    await until(() => shown() !== null && Number(shown()) !== id)
    return Number(shown())
  }
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

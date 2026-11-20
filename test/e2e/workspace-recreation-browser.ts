/** Test-only browser driver. Its network namespace belongs to the disposable runtime container. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const phase = process.argv[2]
assert.ok(phase === 'prepare' || phase === 'verify')
const ids = JSON.parse(await readFile('/proof/recreation.json', 'utf8')) as {
  left: number
  right: number
}
const executablePath = process.env.ULTIMATE_CHROMIUM
assert.ok(executablePath)
const browser = await chromium.launchPersistentContext('/browser-profile', {
  executablePath,
  headless: true,
  env: { ...process.env, TMPDIR: undefined },
  viewport: { width: 1280, height: 900 },
})
try {
  // Automated clients intentionally keep selection local. Test the normal-user path that persists shared UI state.
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  const page = browser.pages()[0] ?? (await browser.newPage())
  const composer = (id: number) =>
    page.locator(`#app [data-ui="composer"] textarea[data-conversation="${id}"]`)
  const choose = async (id: number) => {
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/ui') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.set?.['shell.conversation'] === id,
    )
    await page.locator(`#app [data-ui="ordinary-row"][data-conversation="${id}"]`).click()
    assert.equal((await saved).status(), 200)
    await composer(id).waitFor()
  }
  const draft = (id: number) => (id === ids.left ? 'Unsent left draft' : 'Unsent right draft')
  if (phase === 'prepare') {
    await page.goto(`http://127.0.0.1:4747/?conversation=${ids.right}`)
    await composer(ids.right).waitFor()
    await composer(ids.right).fill(draft(ids.right))
    await choose(ids.left)
    await composer(ids.left).fill(draft(ids.left))
    await choose(ids.right)
    assert.equal(await composer(ids.right).inputValue(), draft(ids.right))
    // Leave the older chat selected, not the latest chat that an empty selection would open.
    await choose(ids.left)
    assert.equal(await composer(ids.left).inputValue(), draft(ids.left))
  } else {
    await page.goto('http://127.0.0.1:4747/')
    await composer(ids.left).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('conversation'), String(ids.left))
    assert.equal(await composer(ids.left).inputValue(), draft(ids.left))
    await choose(ids.right)
    assert.equal(await composer(ids.right).inputValue(), draft(ids.right))
  }
  const stored = await page.evaluate(
    ([left, right]) => [left, right].map((id) => localStorage.getItem(`ultimate.draft.${id}`)),
    [ids.left, ids.right],
  )
  assert.deepEqual(stored, [draft(ids.left), draft(ids.right)])
  await writeFile(
    `/proof/browser-${phase}.json`,
    JSON.stringify({ phase, drafts: stored, passed: true }) + '\n',
  )
  console.log(JSON.stringify({ phase, browserPassed: true }))
} finally {
  await browser.close()
}

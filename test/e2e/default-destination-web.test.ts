import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { defaultDestinationFixture } from '../default-destination-fixture.ts'

it('puts a shared draft in the configured resident conversation without sending it', async () => {
  const f = await defaultDestinationFixture()
  try {
    const browser = await chromium.launch({
      executablePath: await browserBinary(),
      headless: true,
      env: { ...process.env, TMPDIR: undefined },
    })
    try {
      const page = await browser.newPage()
      await page.goto(f.server.url)
      await page.locator('[data-ui="no-conversation"]').waitFor()
      await page.evaluate(async () => {
        const cache = await caches.open('ultimate-share')
        await cache.put(
          '/share/route-test',
          Response.json({
            title: '',
            text: 'Shared draft for neutral',
            url: '',
            files: [],
          }),
        )
      })
      await page.goto(`${f.server.url}/?share=route-test`)
      await expect
        .poll(async () => {
          const composer = page.locator(`textarea[data-conversation="${f.neutral}"]`)
          return (await composer.count()) ? composer.inputValue() : undefined
        })
        .toBe('Shared draft for neutral')
      await page
        .getByRole('button', { name: 'Composer sends to @neutral · Tab switches' })
        .waitFor()
      const target = (await f.server.harness.conversation(f.neutral, context))!
      expect(
        (await target.context(context)).entries.filter((entry) => entry.kind === 'pi.user'),
      ).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await f.close()
  }
})

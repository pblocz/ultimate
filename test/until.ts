import { setImmediate as yieldIO } from 'node:timers/promises'

// oxlint-disable-next-line ultimate/no-local-test-polling -- Shared implementation; helpers.ts re-exports it. Minimal-server tests must not import helpers.ts's coding modules.
export async function until(
  test: () => boolean | Promise<boolean>,
  timeout = 30000,
  tick?: () => Promise<unknown>,
) {
  const deadline = performance.now() + timeout
  while (!(await test())) {
    if (performance.now() > deadline) throw new Error('Timed out')
    await tick?.()
    await yieldIO()
  }
}

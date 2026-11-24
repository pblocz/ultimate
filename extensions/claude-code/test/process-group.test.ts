// fast-test-reason: process.kill is mocked; no subprocesses are started.
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { killProcessTree } from '@earendil-works/pi-claude-code/src/claude-cli.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const child = (pid: number) =>
  Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    kill: vi.fn<(signal: string) => boolean>(),
  })

// #562356: a test's fake Claude Code child had pid 1, and the provider's process.kill(-1, 'SIGKILL') ended the user's
// desktop session. test/no-group-signals.ts already keeps this file from signalling anything real.
it('ends a child whose pid names no group alone, and signals the group of a real pid', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  for (const pid of [1, 0, -1, -42, 1.5, Number.NaN]) {
    // Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — killProcessTree ends such a child alone.
    const alone = child(pid)
    killProcessTree(alone as never)
    expect(alone.kill).toHaveBeenCalledWith('SIGKILL')
  }
  expect(kill).not.toHaveBeenCalled()

  const grouped = child(42)
  killProcessTree(grouped as never)
  expect(kill.mock.calls).toEqual([[-42, 'SIGKILL']])
  expect(grouped.kill).not.toHaveBeenCalled()
})

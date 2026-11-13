import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { PendingAgentCore } from '../agent-core-recovery.ts'

const runner = fileURLToPath(new URL('./agent-core-runner.ts', import.meta.url))
type Packet = { phase: string; ids?: PendingAgentCore; result?: Record<string, unknown> }
function start(root: string, phase: 'pending' | 'recover', ids?: PendingAgentCore) {
  const child = spawn(process.execPath, [runner, root, phase, JSON.stringify(ids ?? null)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-12000)
    })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const packet = new Promise<Packet>((resolve, reject) => {
    child.once('message', (message) => resolve(message as Packet))
    child.once('error', reject)
    child.once('close', (code, signal) =>
      reject(new Error(`Agent-core test process closed (${code ?? signal}): ${output}`)),
    )
  })
  return { child, closed, packet }
}
it('recovers pending child, message and schedule work after a process crash with coding modules absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-agent-core-process-'))
  const children: ReturnType<typeof start>[] = []
  try {
    const first = start(root, 'pending')
    children.push(first)
    const pending = await first.packet
    expect(pending.phase).toBe('pending')
    expect(pending.ids).toBeDefined()
    first.child.kill('SIGKILL')
    expect((await first.closed).signal).toBe('SIGKILL')
    const second = start(root, 'recover', pending.ids)
    children.push(second)
    const recovered = await second.packet
    expect(recovered.phase).toBe('recovered')
    expect(recovered.result).toMatchObject({
      childReports: 1,
      messageReplies: 1,
      notifications: 1,
      childRecovered: true,
      messageRecovered: true,
      scheduleRuns: 1,
      scheduleAnswer: 'SCHEDULE_RECOVERED',
      schedulerRecovered: true,
      diagnostics: [],
      missing: [],
      cycles: [],
    })
    expect((await second.closed).code).toBe(0)
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    }
    await rm(root, { recursive: true, force: true })
  }
})

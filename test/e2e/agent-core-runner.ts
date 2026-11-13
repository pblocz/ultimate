/** Ordinary Node test process. IPC carries test IDs and results, never application work. */
import { agentCoreFixture } from '../agent-core-fixture.ts'
import { pendingAgentCore, recoveredAgentCore, recoveryModel } from '../agent-core-recovery.ts'
import type { PendingAgentCore } from '../agent-core-recovery.ts'

const [root, phase, serialized] = process.argv.slice(2)
if (!root || !['pending', 'recover'].includes(phase))
  throw new Error('Expected a test root and pending or recover phase')
const fixture = await agentCoreFixture({ root })
try {
  await fixture.open(recoveryModel(phase === 'pending'))
  if (phase === 'pending') {
    const ids = await pendingAgentCore(fixture)
    process.send?.({ phase: 'pending', ids })
    // The parent kills this process to test crash recovery while the native work remains pending.
  } else {
    const ids = JSON.parse(serialized) as PendingAgentCore
    const result = await recoveredAgentCore(fixture, ids)
    await fixture.close()
    process.send?.({ phase: 'recovered', result })
    process.disconnect?.()
  }
} catch (error) {
  console.error(error)
  await fixture.close()
  process.exitCode = 1
  process.disconnect?.()
}

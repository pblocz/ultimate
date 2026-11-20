/** Test-only runtime for two sequential disposable containers over the same temporary mounts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { writeFamilies } from '../../lib/families-settings.ts'
import { context } from '../../server/harness.ts'
import { prepareServer } from '../../server/main.ts'
import { projectDecision } from '../../server/project-setup.ts'
import { UiState } from '../../server/ui-state.ts'
import { Family, Profile } from '../../shared/conversation-configuration.ts'
import { until } from '../until.ts'

const phase = process.argv[2]
assert.ok(phase === 'prepare' || phase === 'verify')
const workspace = '/workspace'
const userHome = '/home/node'
const record = join(userHome, 'recreation.json')
const marker = resolve('phase4-runtime-edit.txt')
const auth = join(userHome, '.pi/agent/auth.json')
const payload = 'Shared file retained across container recreation.\n'
const probe = join(workspace, '.ultimate/extensions/recreation-probe')

if (phase === 'prepare') {
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(join(userHome, '.pi/agent'), { recursive: true })
  await mkdir(join(workspace, '.ultimate/agents'), { recursive: true })
  await mkdir(probe, { recursive: true })
  await writeFile(auth, '{}\n')
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { disable: ['coding-workflow', 'dream', 'update', 'keep-warm', 'goal'] },
    }),
  )
  await writeFile(
    join(workspace, '.ultimate/agents/helper.md'),
    '---\nname: helper\ndescription: Recreation helper\ntools: [read, write]\n---\nUse the shared workspace.\n',
  )
  await writeFile(
    join(probe, 'server.ts'),
    "export default { name: 'recreation-probe' }; export const actions = { value: async () => 'retained extension' };\n",
  )
  await writeFamilies(userHome, workspace, {
    families: {
      quick: { model: 'faux/faux-1', thinking: 'off' },
      deliberate: { model: 'faux/faux-2', thinking: 'high' },
    },
  })
}

assert.equal(process.getuid?.(), 1000)
await access(resolve('server/main.ts'), 2)
for (const path of ['/var/run/docker.sock', '/usr/bin/chromium', '/usr/bin/xdg-open'])
  assert.equal(existsSync(path), false)
for (const name of ['claude', 'docker', 'chromium', 'xdg-open'])
  assert.equal(
    process.env.PATH?.split(':').some((path) => existsSync(join(path, name))),
    false,
  )
const server = await prepareServer({
  ultimateRoot: resolve('.'),
  projectRoot: workspace,
  port: 4747,
  faux: fauxProvider({
    tokensPerSecond: 0,
    models: [{ id: 'faux-1' }, { id: 'faux-2', reasoning: true }],
  }),
})
let requests = 0
const rightTranscripts: string[] = []
const text = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))
const respond: FauxResponseFactory = (request) => {
  server.host.faux!.appendResponses([respond])
  requests++
  const asked = text(request.messages.findLast((message) => message.role === 'user')?.content)
  if (asked.includes('RIGHT_PRIVATE')) rightTranscripts.push(JSON.stringify(request.messages))
  const last = request.messages.findLast((message) => message.role !== 'system')!
  if (last.role === 'toolResult') return fauxAssistantMessage(`Completed: ${text(last.content)}`)
  const call = asked.includes('INSTALL_MARKER')
    ? fauxToolCall('write', { path: marker, content: 'Ephemeral application edit.\n' })
    : asked.includes('RIGHT_PRIVATE')
      ? fauxToolCall('read', { path: 'shared.txt' })
      : fauxToolCall('write', { path: 'shared.txt', content: payload })
  return fauxAssistantMessage([call], { stopReason: 'toolUse' })
}
server.host.faux!.setResponses([respond])
const opened = await server.go()
const post = async (path: string, body: object) => {
  const response = await fetch(server.url + path, {
    method: 'POST',
    headers: { Origin: server.url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  assert.ok(response.ok, JSON.stringify(result))
  return result
}
const ask = async (id: number, content: string) => {
  const conversation = await opened.harness.conversation(id as ConversationId, context)
  assert.ok(conversation)
  const receipt = await conversation.submit({ type: 'input', content, requestId: content }, context)
  await receipt.wait(context)
}
const history = async (id: number) => {
  const conversation = await opened.harness.conversation(id as ConversationId, context)
  assert.ok(conversation)
  const entries = (await conversation.entries({ order: 'ascending' }, 1000, undefined, context))
    .items
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}
const invoke = () =>
  server.extensions.invoke('recreation-probe', 'value', null, new AbortController().signal)
let ids: { left: number; right: number; histories: string[] }
if (phase === 'prepare') {
  assert.equal(projectDecision(workspace, userHome), null)
  // Settings list untrusted extensions as available but disabled; their facets must not load before trust.
  const untrusted = server.extensions
    .info()
    .find((extension) => extension.name === 'recreation-probe')
  assert.ok(untrusted)
  assert.equal(untrusted.enabled, false)
  assert.equal(untrusted.server?.loadedAt, undefined)
  await post('/api/extensions/onboarding/actions/decide', { args: { local: true } })
  await until(() =>
    server.extensions
      .info()
      .some(
        (extension) =>
          extension.name === 'recreation-probe' && extension.server?.loadedAt !== undefined,
      ),
  )
  assert.equal(await invoke(), 'retained extension')
  const left = (await post('/api/conversations', { definition: 'helper', preset: 'quick' }))
    .id as number
  const right = (await post('/api/conversations', { definition: 'helper', preset: 'deliberate' }))
    .id as number
  await ask(left, 'LEFT_PRIVATE: write the shared file')
  await ask(left, 'INSTALL_MARKER')
  await ask(right, 'RIGHT_PRIVATE: read the shared file')
  await opened.harness.waitForIdle(context)
  assert.equal(await readFile(marker, 'utf8'), 'Ephemeral application edit.\n')
  assert.equal(requests, 6)
  assert.ok(rightTranscripts.length > 0)
  assert.ok(rightTranscripts.every((transcript) => !transcript.includes('LEFT_PRIVATE')))
  ids = { left, right, histories: [await history(left), await history(right)] }
  await writeFile(record, JSON.stringify(ids) + '\n')
} else {
  ids = JSON.parse(await readFile(record, 'utf8')) as typeof ids
  assert.equal(existsSync(marker), false)
  assert.equal(projectDecision(workspace, userHome), true)
  assert.equal(await invoke(), 'retained extension')
  assert.deepEqual([await history(ids.left), await history(ids.right)], ids.histories)
  assert.equal(
    (await opened.harness.snapshot(UiState, opened.root.id, context))?.['shell.conversation'],
    ids.left,
  )
  assert.equal(requests, 0)
}
assert.equal(await readFile(join(workspace, 'shared.txt'), 'utf8'), payload)
assert.equal(await readFile(auth, 'utf8'), '{}\n')
for (const id of [ids.left, ids.right])
  assert.equal(
    (await opened.harness.snapshot(Profile, id as ConversationId, context))?.definition,
    'helper',
  )
assert.equal(
  (await opened.harness.snapshot(Family, ids.left as ConversationId, context))?.name,
  'quick',
)
assert.equal(
  (await opened.harness.snapshot(Family, ids.right as ConversationId, context))?.name,
  'deliberate',
)
const leftAgent = await (await opened.harness.conversation(
  ids.left as ConversationId,
  context,
))!.agent(context)
const rightAgent = await (await opened.harness.conversation(
  ids.right as ConversationId,
  context,
))!.agent(context)
assert.deepEqual(leftAgent.model, { provider: 'faux', modelId: 'faux-1' })
assert.deepEqual(rightAgent.model, { provider: 'faux', modelId: 'faux-2' })
assert.equal(leftAgent.thinkingLevel, 'off')
assert.equal(rightAgent.thinkingLevel, 'high')
assert.deepEqual(server.extensions.catalogue().missing, [])
assert.deepEqual(server.extensions.catalogue().cycles, [])
await writeFile(
  join(userHome, `runtime-${phase}.json`),
  JSON.stringify({ phase, ids, state: server.host.home, requests, ready: true }) + '\n',
)
console.log(JSON.stringify({ phase, ready: true, state: server.host.home, requests }))
const stopped = new Promise<void>((done) => {
  process.once('SIGTERM', done)
  process.once('SIGINT', done)
})
await stopped
await server.vite.watcher.close()
await server.close()

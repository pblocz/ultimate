import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { git } from '../../extensions/project-git/support/run.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'
import { omittedExtensions, ordinarySource } from '../ordinary-web-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('retains source edits, live extension reloads and ordinary shell Git without a coding workflow', async () => {
  const home = await temp('ultimate-mutable-runtime-')
  cleanup.push(() => removeTemp(home))
  const source = await ordinarySource(join(home, 'source'))
  const workspace = join(home, 'workspace')
  const userHome = join(home, 'user')
  await mkdir(workspace)
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  const extension = join(source, 'extensions/runtime-probe')
  await mkdir(extension)
  const file = join(extension, 'server.ts')
  const code = (value: string) => `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'runtime-probe' })
export const actions = { version: async () => ${JSON.stringify(value)} }
`
  await writeFile(file, code('before'))
  const server = await fauxServer({
    ultimateRoot: source,
    projectRoot: workspace,
    userHome,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  for (const name of omittedExtensions)
    await expect(access(join(source, 'extensions', name))).rejects.toThrow('ENOENT')
  const version = () =>
    server.extensions.invoke('runtime-probe', 'version', null, new AbortController().signal)
  expect(await version()).toBe('before')
  const systems: string[] = []
  const respond: FauxResponseFactory = (request) => {
    server.host.faux!.appendResponses([respond])
    systems.push(JSON.stringify(request.messages.filter((message) => message.role === 'system')))
    const last = request.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'toolResult') return fauxAssistantMessage('Done')
    if (last.role === 'user' && last.content === 'EDIT_INSTALLATION')
      return fauxAssistantMessage([fauxToolCall('write', { path: file, content: code('after') })], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage(
      [
        fauxToolCall('bash', {
          command:
            'git init --initial-branch=plain && git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m Initial && git status --porcelain',
        }),
      ],
      { stopReason: 'toolUse' },
    )
  }
  server.host.faux!.setResponses([respond])
  const created = await post(server, '/api/conversations')
  expect(created.status).toBe(201)
  const id = created.data.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  const tools = (await conversation.agent(context)).tools.map((tool) => tool.name)
  expect(tools).toContain('write')
  expect(tools).toContain('bash')
  expect(tools).not.toContain('branch')
  await (
    await conversation.submit({ type: 'input', content: 'EDIT_INSTALLATION' }, context)
  ).wait(context)
  expect(await readFile(file, 'utf8')).toBe(code('after'))
  await until(async () => (await version()) === 'after')
  await expect(access(join(workspace, '.git'))).rejects.toThrow('ENOENT')
  await (
    await conversation.submit({ type: 'input', content: 'GIT_WORKSPACE' }, context)
  ).wait(context)
  expect(await git(workspace, 'branch', '--format=%(refname:short)')).toBe('plain')
  expect(await git(workspace, 'status', '--porcelain')).toBe('')
  expect(
    (await git(workspace, 'worktree', 'list', '--porcelain')).match(/^worktree /gm),
  ).toHaveLength(1)
  expect(systems).toHaveLength(4)
  for (const system of systems) {
    expect(system).toContain(`Effective working directory: ${workspace}`)
    expect(system).toContain(`Shared workspace: ${workspace}`)
    expect(system).toContain(`Installed application: ${source}`)
    expect(system).toContain('Commands and paths use the server process environment')
    expect(system).not.toContain('Work checkout (effective cwd):')
  }
  expect(server.extensions.catalogue()).toMatchObject({ missing: [], cycles: [] })
})

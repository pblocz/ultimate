// Phase 7A: each Git provider works without the other. `source-git` covers Ultimate's own checkout; `project-git`
// covers the user's repositories through the installation's startup module and the Bash instrumentation point.
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { Committed } from '../../extensions/coding-tools/refs.ts'
import { context } from '../../server/harness.ts'
import { git } from '../git.ts'
import { eventHost, fauxServer, post, removeTemp, temp, until } from '../helpers.ts'
import { ordinarySource } from '../ordinary-web-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const text = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block: { text?: string }) => block.text ?? '').join('')
      : ''

/**
 * The ordinary inventory with `extensions` added, and a user project that is a linked worktree of a main checkout. Only
 * the main checkout is trusted, so the project is trusted only where the identity module maps the worktree to it.
 */
async function assembly(name: string, extensions: string[], startupModule: boolean) {
  const home = await temp(`ultimate-${name}-`)
  cleanup.push(() => removeTemp(home))
  const source = await ordinarySource(join(home, 'source'))
  for (const extension of extensions)
    await cp(resolve('extensions', extension), join(source, 'extensions', extension), {
      recursive: true,
      filter: (path) => !path.slice(resolve('extensions', extension).length).startsWith('/test'),
    })
  if (startupModule)
    await cp(resolve('ultimate-startup.json'), join(source, 'ultimate-startup.json'))
  const main = join(home, 'project')
  await mkdir(main)
  await git(main, 'init', '-qb', 'main')
  await git(main, 'config', 'user.name', 'Assembly Test')
  await git(main, 'config', 'user.email', 'assembly@example.test')
  await git(main, 'commit', '-q', '--allow-empty', '-m', 'base')
  const linked = join(home, 'linked')
  await git(main, 'worktree', 'add', '-q', '-b', 'side', linked)
  const userHome = join(home, 'user')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  new ProjectTrustStore(join(userHome, '.ultimate')).set(await realpath(main), true)
  // A user message `bash: <command>` runs the command; a tool result is echoed.
  const respond: FauxResponseFactory = (request) => {
    server.host.faux!.appendResponses([respond])
    const last = request.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'toolResult') return fauxAssistantMessage(`Done: ${text(last.content)}`)
    const asked = text(last.content)
    const command = /^bash: (.+)$/s.exec(asked)?.[1]
    return command
      ? fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' })
      : fauxAssistantMessage('Plain answer.')
  }
  const server = await fauxServer({
    ultimateRoot: source,
    projectRoot: linked,
    userHome,
    home: join(home, 'state'),
    port: 0,
    localSetup: false,
    faux: fauxProvider({ models: [{ id: 'faux-1' }] }),
  })
  cleanup.push(() => server.close())
  server.host.faux!.setResponses([respond])
  const info = () => server.system.current()
  const loaded = () => info().extensions.map((extension) => extension.name)
  const errors = () =>
    info().extensions.flatMap((extension) =>
      extension.server?.error ? [`${extension.name}: ${extension.server.error}`] : [],
    )
  const chat = async () => {
    const created = await post(server, '/api/conversations', {})
    expect(created.status).toBe(201)
    return created.data.id as number
  }
  /** Submit `input` to conversation `id`, wait for the run, and return its entries. */
  const turn = async (id: number, input: string) => {
    expect((await post(server, `/api/conversations/${id}/submit`, { text: input })).status).toBe(
      202,
    )
    await server.harness.waitForIdle(context)
    const page = await fetch(`${server.url}/api/conversations/${id}/history?before=1000000`)
    return (await page.json()).entries as { kind: string; data?: unknown }[]
  }
  const commits = () =>
    eventHost(() => server.harness, 'test').eventLog.recent({ events: [Committed] })
  return {
    server,
    source,
    main: await realpath(main),
    linked: await realpath(linked),
    info,
    loaded,
    errors,
    chat,
    turn,
    commits,
  }
}

it('runs source-git without project-git: source status and landings, no project hooks or worktree identity', async () => {
  const f = await assembly('source-git-only', ['source-git'], false)
  expect(f.loaded()).toContain('source-git')
  expect(f.loaded()).not.toContain('project-git')
  expect(f.errors()).toEqual([])

  // Ultimate's source is a checkout of its own, separate from the user project.
  const file = 'extensions/messages/server.ts'
  const commit = async (subject: string) => {
    await git(f.source, 'add', '-f', file)
    await git(
      f.source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      subject,
    )
    return git(f.source, 'rev-parse', 'HEAD')
  }
  await git(f.source, 'init', '-qb', 'fixture')
  await writeFile(join(f.source, '.git/info/exclude'), '*\n')
  const first = await commit('Initial source')
  // The status publisher listens to the watcher's `all` event. Git metadata is not watched.
  const refreshStatus = () => f.server.vite.watcher.emit('all', 'change', join(f.source, file))
  refreshStatus()
  await until(() => f.info().code.sha === first.slice(0, 7))
  expect(f.info().code).toMatchObject({ sourceAvailable: true, branch: 'fixture', dirty: false })

  // Without the identity module the linked worktree is its own project: the main checkout's trust does not apply.
  expect(f.server.host.projectAccess.key()).toBe(f.linked)
  expect(f.server.host.projectAccess.trusted()).toBe(false)
  expect(f.server.host.projectAccess.decision()).toBeNull()

  // Bash runs without project Git hooks: no config is injected and a commit gets no trailer or event.
  const id = await f.chat()
  const ran = JSON.stringify(
    await f.turn(
      id,
      'bash: printf "count=%s;" "${GIT_CONFIG_COUNT-unset}"; git commit -q --allow-empty -m from-bash; git log -1 --format=%B',
    ),
  )
  expect(ran).toContain('Done: count=unset;from-bash')
  expect(ran).not.toContain('Ultimate-Conversation')
  expect(await f.commits()).toEqual([])

  // A source change that lands between builds is named in the next build note.
  const before = f.server.host.build().id
  await writeFile(
    join(f.source, file),
    `${await readFile(join(f.source, file), 'utf8')}\n// A source change.\n`,
  )
  const second = await commit('A source change')
  refreshStatus()
  await until(() => f.server.host.build().id !== before && f.info().code.sha === second.slice(0, 7))
  const notes = (await f.turn(id, 'after the change')).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(notes.at(-1)?.data).toMatchObject({ landed: [{ title: 'A source change', sha: second }] })
})

it('runs project-git without source-git: commit events and worktree identity, no source status', async () => {
  const f = await assembly('project-git-only', ['project-git'], true)
  expect(f.loaded()).toContain('project-git')
  expect(f.loaded()).not.toContain('source-git')
  expect(f.errors()).toEqual([])

  // The startup module maps the linked worktree to its main checkout, so the main checkout's trust applies.
  expect(f.server.host.projectAccess.key()).toBe(f.main)
  expect(f.server.host.projectAccess.trusted()).toBe(true)

  // Ultimate's source has no checkout: no source status.
  expect(f.info().code).toMatchObject({ sourceAvailable: false, branch: '', sha: '' })

  // Bash reports the commit it made in the linked worktree, with the conversation's trailer.
  const id = await f.chat()
  const ran = JSON.stringify(
    await f.turn(id, 'bash: git commit -q --allow-empty -m from-bash; git log -1 --format=%B'),
  )
  expect(ran).toContain(`Ultimate-Conversation: ${id}`)
  const sha = await git(f.linked, 'rev-parse', 'HEAD')
  await until(async () => (await f.commits()).length > 0)
  expect((await f.commits()).map((event) => event.data)).toEqual([
    expect.objectContaining({ conversation: id, sha, branch: 'side', subject: 'from-bash' }),
  ])

  // A build change gives the generic note, with no landing details.
  const before = f.server.host.build().id
  await writeFile(join(f.server.host.ultimateRoot, 'extensions/messages/note.ts'), 'export {}\n')
  await until(() => f.server.host.build().id !== before)
  const notes = (await f.turn(id, 'after the change')).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(notes.at(-1)?.data).toEqual({ from: before, to: f.server.host.build().id })
  expect(f.info().code.sourceAvailable).toBe(false)
})

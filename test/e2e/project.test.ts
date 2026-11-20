import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectHome, runtimePaths } from '../../server/project.ts'
import { projectDecision } from '../../server/project-setup.ts'
import { readFamilies, writeFamilies } from '../../lib/families-settings.ts'
import { git } from '../../lib/git.ts'
import { attach, temp, sourceCopy, cleanEnv, until, post as requestPost } from '../helpers.ts'

const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
})
async function post(url: string, path: string, args: unknown = null) {
  return requestPost(url, path, { args })
}
async function extension(root: string, name: string, value: string) {
  const path = join(root, 'extensions', name)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: '${name}' })
export const actions = { hello: async (args, ctx) => ({ args, value: '${value}', cwd: (await ctx.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout }) }`,
  )
}

it('keeps linked-worktree trust and preset sharing independent of explicit runtime state', async () => {
  const userHome = await temp('ultimate-worktree-config-')
  const main = join(userHome, 'main')
  const linked = join(userHome, 'linked')
  await mkdir(main)
  await git(main, 'init', '--initial-branch=main')
  await git(
    main,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initial fixture',
  )
  await git(main, 'worktree', 'add', '-b', 'linked', linked)
  new ProjectTrustStore(join(userHome, '.ultimate')).set(main, true)
  await writeFamilies(userHome, main, { families: { local: { model: 'faux/first' } } })
  expect(projectDecision(linked, userHome)).toBe(true)
  expect((await readFamilies(userHome, linked)).families.local.model).toBe('faux/first')
  const state = runtimePaths(linked, { userHome, home: join(userHome, 'separate-state') })
  expect(state.home).toBe(join(userHome, 'separate-state'))
  await writeFamilies(state.userHome, linked, { families: { local: { model: 'faux/second' } } })
  expect((await readFamilies(userHome, main)).families.local.model).toBe('faux/second')
  expect(projectDecision(main, userHome)).toBe(true)
  expect(existsSync(state.home)).toBe(false)
})

it('prints a single-line error for a missing project', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const missing = join(userHome, 'missing')
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), missing, '--no-open'],
    {
      cwd: ultimateRoot,
      env: cleanEnv({ HOME: userHome, ULTIMATE_HOME: join(userHome, 'state') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let error = ''
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  const [code] = await once(child, 'exit')
  expect(code).toBe(1)
  expect(error.trim().split('\n')).toEqual([`Cannot open project ${missing}: ENOENT`])
})

it('starts two project supervisors concurrently on distinct free ports and storage, serving hello live', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const projects = [await temp(), await temp()]
  await extension(join(projects[0], '.ultimate'), 'hello', 'live')
  const launch = (project: string) => {
    const home = projectHome(project, userHome)
    new ProjectTrustStore(join(userHome, '.ultimate')).set(project, true)
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      HOME: userHome,
      ULTIMATE_HOME: home,
    }
    delete env.ULTIMATE_PORT
    const child = spawn(
      process.execPath,
      [join(ultimateRoot, 'bin/ultimate.ts'), project, '--no-open', '--port', '0'],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    return { home, output: () => output }
  }
  const runs = projects.map(launch)
  await until(() => runs.every((run) => run.output().includes('Ultimate: http://')))
  const urls = runs.map((run) => /Ultimate: (http:\/\/[^\s]+)/.exec(run.output())![1])
  expect(urls[0]).not.toBe(urls[1])
  expect(runs[0].home).not.toBe(runs[1].home)
  for (const [index, run] of runs.entries()) {
    const owner = JSON.parse(await readFile(join(run.home, 'ultimate.lock'), 'utf8'))
    expect(owner).toMatchObject({
      project: projects[index],
      port: Number(new URL(urls[index]).port),
    })
    expect(owner.port).toBeGreaterThan(0)
    expect(existsSync(join(run.home, 'state.sqlite'))).toBe(true)
    const stream = await attach(urls[index])
    try {
      await until(() => !!stream.system())
      const system = stream.system()
      expect(system.project.root).toBe(projects[index])
      expect(system.persistence.path).toBe(join(run.home, 'state.sqlite'))
    } finally {
      await stream.close()
    }
  }
  expect(await post(urls[0], '/api/extensions/hello/actions/hello', 'hi')).toEqual({
    status: 200,
    data: { result: { args: 'hi', value: 'live', cwd: projects[0] } },
  })
}, 60000)

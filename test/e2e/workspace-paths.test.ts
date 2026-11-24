import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { projectHome } from '../../server/project.ts'
import { attach, cleanEnv, sourceCopy, temp, until } from '../helpers.ts'
import { scriptedModel } from './scripted-model.ts'

const run = promisify(execFile)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function fixture() {
  const root = await temp('ultimate-workspace-paths-')
  const ultimateRoot = await sourceCopy(root)
  const workspace = join(root, 'workspace')
  const launch = join(root, 'launch')
  const osHome = join(root, 'os-home')
  const userHome = join(root, 'config-home')
  for (const path of [workspace, launch, osHome, userHome]) {
    await mkdir(join(path, '.ultimate'), { recursive: true })
    await writeFile(
      join(path, '.ultimate/settings.json'),
      JSON.stringify({
        onboarding: false,
        extensions: { disable: ['update', 'dream', 'coding-workflow'] },
      }),
    )
  }
  const model = await scriptedModel(() => ({ text: 'Unused test model' }))
  cleanup.push(model.close)
  const start = (home?: string) => {
    const child = spawn(
      process.execPath,
      [join(ultimateRoot, 'bin/ultimate.ts'), workspace, '--no-open', '--port', '0'],
      {
        cwd: launch,
        env: cleanEnv({
          ...model.env,
          HOME: osHome,
          ULTIMATE_USER_HOME: userHome,
          ...(home !== undefined && { ULTIMATE_HOME: home }),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const exited = once(child, 'exit')
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited
      }
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    return {
      child,
      output: () => output,
      async settled() {
        await until(() => child.exitCode !== null || output.includes('Ultimate: http://'))
      },
      async persistence() {
        await this.settled()
        expect(child.exitCode).toBeNull()
        const url = /Ultimate: (http:\/\/[^\s]+)/.exec(output)![1]
        const stream = await attach(url)
        try {
          await until(() => !!stream.system())
          return stream.system().persistence.path
        } finally {
          await stream.close()
        }
      },
    }
  }
  return { ultimateRoot, workspace, launch, osHome, userHome, start }
}

it('uses the configured user home for default state in the supervisor and its child', async () => {
  const f = await fixture()
  const state = projectHome(f.workspace, f.userHome)
  const running = f.start()
  expect(await running.persistence()).toBe(join(state, 'state.sqlite'))
  expect(existsSync(join(state, 'ultimate.lock.db'))).toBe(true)
  expect(existsSync(projectHome(f.workspace, f.osHome))).toBe(false)
})

it('resolves a relative state path before the supervisor changes its child working directory', async () => {
  const f = await fixture()
  const state = join(f.launch, 'state')
  const running = f.start('state')
  expect(await running.persistence()).toBe(join(state, 'state.sqlite'))
  expect(existsSync(join(state, 'ultimate.lock.db'))).toBe(true)
  expect(existsSync(join(f.workspace, 'state'))).toBe(false)
})

const legacyCases = [
  { name: 'custom user home', relative: false },
  { name: 'relative state', relative: true },
]
for (const scenario of legacyCases) {
  it.each(['state.sqlite', 'chapters.json', 'pending-chapter.json'])(
    `refuses ${scenario.name} with existing %s at the old path before any state write`,
    async (marker) => {
      const f = await fixture()
      const old = scenario.relative
        ? join(f.workspace, 'state')
        : projectHome(f.workspace, f.osHome)
      const selected = scenario.relative
        ? join(f.launch, 'state')
        : projectHome(f.workspace, f.userHome)
      await mkdir(old, { recursive: true })
      const path = join(old, marker)
      if (marker === 'state.sqlite') {
        const db = new DatabaseSync(path)
        db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('old state')")
        db.close()
      } else {
        await writeFile(
          path,
          JSON.stringify(
            marker === 'chapters.json'
              ? { active: 'the-beginning', chapters: [{ name: 'the-beginning' }] }
              : { to: 'the-beginning' },
          ),
        )
      }
      const before = await readFile(path)
      const running = f.start(scenario.relative ? 'state' : undefined)
      await running.settled()
      expect(running.child.exitCode).toBe(1)
      expect(running.output()).toContain(old)
      expect(running.output()).toContain(selected)
      expect(running.output()).toContain('ULTIMATE_HOME')
      expect(await readFile(path)).toEqual(before)
      expect(existsSync(selected)).toBe(false)
      expect(existsSync(join(old, 'ultimate.lock.db'))).toBe(false)
    },
  )
}

it.each(['reset', 'restore'])(
  '%s refuses ambiguous state before any maintenance operation',
  async (script) => {
    const f = await fixture()
    const old = projectHome(f.workspace, f.osHome)
    const selected = projectHome(f.workspace, f.userHome)
    await mkdir(old, { recursive: true })
    const marker = join(old, 'chapters.json')
    await writeFile(marker, 'Preserve old state.\n')
    const args = script === 'reset' ? [f.workspace] : ['--dir', f.workspace]
    const result = await run(
      process.execPath,
      // As in the package scripts, extension helpers reach the host by name.
      [
        '--import',
        join(f.ultimateRoot, 'lib/node-names.ts'),
        join(f.ultimateRoot, 'scripts', `${script}.ts`),
        ...args,
        '--dry-run',
      ],
      {
        cwd: f.launch,
        env: cleanEnv({ HOME: f.osHome, ULTIMATE_USER_HOME: f.userHome }),
      },
    ).catch((error: { code: number; stderr: string }) => error)
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('ULTIMATE_HOME') })
    expect(result.stderr).toContain(old)
    expect(result.stderr).toContain(selected)
    expect(await readFile(marker, 'utf8')).toBe('Preserve old state.\n')
    expect(existsSync(selected)).toBe(false)
  },
)

it.each([false, true])(
  'reset dry-run resolves the selected state without changing it: relative = %s',
  async (relativeState) => {
    const f = await fixture()
    const home = relativeState ? join(f.launch, 'state') : projectHome(f.workspace, f.userHome)
    await mkdir(home, { recursive: true })
    const marker = join(home, 'state.sqlite')
    await writeFile(marker, 'Preserve selected state.\n')
    const before = await readFile(marker)
    const result = await run(
      process.execPath,
      [
        '--import',
        join(f.ultimateRoot, 'lib/node-names.ts'),
        join(f.ultimateRoot, 'scripts/reset.ts'),
        f.workspace,
        '--dry-run',
      ],
      {
        cwd: f.launch,
        env: cleanEnv({
          HOME: f.osHome,
          ULTIMATE_USER_HOME: f.userHome,
          ...(relativeState && { ULTIMATE_HOME: 'state' }),
        }),
      },
    )
    expect(result.stdout).toContain(`home   ${home}`)
    expect(result.stdout).toContain('move state.sqlite')
    expect(await readFile(marker)).toEqual(before)
    expect(existsSync(join(f.osHome, '.ultimate/backups'))).toBe(false)
  },
)

it('uses an explicit absolute state path even when a different legacy home exists', async () => {
  const f = await fixture()
  const old = projectHome(f.workspace, f.osHome)
  await mkdir(old, { recursive: true })
  const marker = join(old, 'chapters.json')
  await writeFile(marker, 'Existing legacy state, not selected.\n')
  const state = join(f.launch, 'selected')
  const running = f.start(state)
  expect(await running.persistence()).toBe(join(state, 'state.sqlite'))
  expect(await readFile(marker, 'utf8')).toBe('Existing legacy state, not selected.\n')
})

import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import { projectHome, runtimePaths } from '../server/project.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

async function fixture() {
  const root = await temp('ultimate-runtime-paths-')
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'config')
  const osHome = join(root, 'user')
  await mkdir(workspace)
  await mkdir(userHome)
  await mkdir(osHome)
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('ULTIMATE_HOME', undefined)
  vi.stubEnv('ULTIMATE_USER_HOME', undefined)
  return { root, workspace, userHome, osHome }
}

it('keeps the existing default path and creates no state while it resolves paths', async () => {
  const f = await fixture()
  expect(homedir()).toBe(f.osHome)
  expect(runtimePaths(f.workspace)).toEqual({
    userHome: f.osHome,
    home: projectHome(f.workspace, f.osHome),
  })
  expect(existsSync(join(f.osHome, '.ultimate'))).toBe(false)
})

it('resolves relative user and state overrides against the caller cwd without changing HOME', async () => {
  const f = await fixture()
  vi.stubEnv('ULTIMATE_USER_HOME', relative(process.cwd(), f.userHome))
  vi.stubEnv('ULTIMATE_HOME', relative(process.cwd(), join(f.root, 'state')))
  expect(runtimePaths(f.workspace)).toEqual({ userHome: f.userHome, home: join(f.root, 'state') })
  expect(homedir()).toBe(f.osHome)
  expect(existsSync(join(f.root, 'state'))).toBe(false)
})

it('lets explicit options win over environment paths', async () => {
  const f = await fixture()
  vi.stubEnv('ULTIMATE_USER_HOME', join(f.root, 'environment-user'))
  vi.stubEnv('ULTIMATE_HOME', join(f.root, 'environment-state'))
  expect(runtimePaths(f.workspace, { userHome: f.userHome, home: join(f.root, 'state') })).toEqual({
    userHome: f.userHome,
    home: join(f.root, 'state'),
  })
})

it.each(['ULTIMATE_HOME', 'ULTIMATE_USER_HOME'])(
  'rejects an empty %s before writes',
  async (key) => {
    const f = await fixture()
    vi.stubEnv(key, '')
    expect(() => runtimePaths(f.workspace)).toThrow(`${key} must not be empty`)
    expect(existsSync(join(f.osHome, '.ultimate'))).toBe(false)
  },
)

it.each(['home', 'userHome'] as const)(
  'rejects an empty %s option instead of using its environment fallback',
  async (key) => {
    const f = await fixture()
    expect(() => runtimePaths(f.workspace, { [key]: '' })).toThrow('must not be empty')
    expect(existsSync(join(f.osHome, '.ultimate'))).toBe(false)
  },
)

it('refuses ambiguous state without changing either existing copy, and accepts an absolute choice', async () => {
  const f = await fixture()
  const old = projectHome(f.workspace, f.osHome)
  const selected = projectHome(f.workspace, f.userHome)
  for (const home of [old, selected]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'state.sqlite'), home)
  }
  vi.stubEnv('ULTIMATE_USER_HOME', f.userHome)
  expect(() => runtimePaths(f.workspace)).toThrow(`Existing state at ${old}`)
  for (const home of [old, selected])
    expect(await readFile(join(home, 'state.sqlite'), 'utf8')).toBe(home)
  expect(runtimePaths(f.workspace, { home: selected })).toEqual({
    userHome: f.userHome,
    home: selected,
  })
})

it('does not treat a symlink alias of the same state directory as conflicting old state', async () => {
  const f = await fixture()
  const legacy = projectHome(f.workspace, f.osHome)
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'state.sqlite'), 'Existing state.\n')
  const alias = join(f.root, 'user-alias')
  await symlink(f.osHome, alias)
  vi.stubEnv('ULTIMATE_USER_HOME', alias)
  expect(runtimePaths(f.workspace)).toEqual({
    userHome: alias,
    home: projectHome(f.workspace, alias),
  })
  expect(await readFile(join(legacy, 'state.sqlite'), 'utf8')).toBe('Existing state.\n')
})

it('uses the same absolute paths when the harness prepares directly', async () => {
  const f = await fixture()
  const home = join(f.root, 'state')
  vi.stubEnv('ULTIMATE_USER_HOME', relative(process.cwd(), f.userHome))
  vi.stubEnv('ULTIMATE_HOME', relative(process.cwd(), home))
  const prepared = await prepareHarness({
    ultimateRoot: resolve('.'),
    projectRoot: f.workspace,
    faux: fauxProvider(),
  })
  expect(prepared.userHome).toBe(f.userHome)
  expect(prepared.home).toBe(home)
  expect(prepared.database).toBe(join(home, 'state.sqlite'))
})

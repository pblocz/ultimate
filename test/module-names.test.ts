import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { extensionModule, modulePath, modulePrefixes } from '../lib/module-names.ts'
import { resolveModuleName } from '../server/vite-names.ts'
import config from '../vite.config.ts'

it('maps each name prefix to its repository folder and keeps a query', () => {
  expect(modulePath('@ultimate/ext/conversations/api.ts')).toBe('extensions/conversations/api.ts')
  expect(modulePath('@ultimate/ext/sidebar/test/web/rows.tsx')).toBe(
    'extensions/sidebar/test/web/rows.tsx',
  )
  expect(modulePath('@ultimate/lib/git.ts')).toBe('lib/git.ts')
  expect(modulePath('@ultimate/shared/extension-api.ts')).toBe('shared/extension-api.ts')
  expect(modulePath('@ultimate/server/extensions.ts')).toBe('server/extensions.ts')
  expect(modulePath('@ultimate/test/helpers.ts')).toBe('test/helpers.ts')
  expect(modulePath('@ultimate/scripts/deps.ts')).toBe('scripts/deps.ts')
  expect(modulePath('@ultimate/lib/source-frames.ts?raw')).toBe('lib/source-frames.ts?raw')
  expect(Object.keys(modulePrefixes)).toHaveLength(6)
})

it('leaves packages, relative paths and the @ alias alone', () => {
  for (const specifier of ['react', '@earendil-works/pi-durable', './api.ts', '../x.ts', '@/sdk'])
    expect(modulePath(specifier)).toBeUndefined()
})

it('rejects an unknown prefix, a missing file and a path that leaves its folder', () => {
  expect(() => modulePath('@ultimate/web/sdk.ts')).toThrow('names no Ultimate module')
  expect(() => modulePath('@ultimate/ext/conversations')).toThrow('@ultimate/ext/<name>/<file>')
  expect(() => modulePath('@ultimate/lib/')).toThrow('must name a file inside lib/')
  expect(() => modulePath('@ultimate/lib/../server/x.ts')).toThrow('must name a file inside lib/')
  expect(() => modulePath('@ultimate/ext/a/./b.ts')).toThrow('must name a file inside extensions/')
})

it('names the extension and its file of an extensions/ path', () => {
  expect(extensionModule('extensions/conversations/api.ts')).toEqual({
    name: 'conversations',
    file: 'api.ts',
  })
  expect(extensionModule('extensions/a/test/b.ts?raw')).toEqual({ name: 'a', file: 'test/b.ts' })
  expect(extensionModule('lib/git.ts')).toBeUndefined()
  expect(extensionModule('extensions/a')).toBeUndefined()
})

it('resolves an extension name to the built-in folder first, and to the outside folder only without one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-module-names-'))
  try {
    await mkdir(join(root, 'extensions/builtin'), { recursive: true })
    const asked: string[] = []
    const outside = async (name: string) => {
      asked.push(name)
      return name === 'outside' ? '/elsewhere/outside' : undefined
    }
    const resolve = async (file: string) => ({ id: file })
    expect(
      await resolveModuleName(root, '@ultimate/ext/builtin/api.ts', undefined, resolve, outside),
    ).toEqual({ id: join(root, 'extensions/builtin/api.ts') })
    expect(
      await resolveModuleName(root, '@ultimate/ext/outside/ui.tsx', undefined, resolve, outside),
    ).toEqual({ id: '/elsewhere/outside/ui.tsx' })
    expect(asked).toEqual(['outside'])
    expect(
      await resolveModuleName(root, '@ultimate/lib/git.ts', undefined, resolve, outside),
    ).toEqual({
      id: join(root, 'lib/git.ts'),
    })
    // Without an outside lookup, a name of no built-in is left to another plugin.
    expect(
      await resolveModuleName(root, '@ultimate/ext/outside/ui.tsx', undefined, resolve),
    ).toBeUndefined()
    expect(await resolveModuleName(root, 'react', undefined, resolve, outside)).toBeUndefined()
    await expect(
      resolveModuleName(root, '@ultimate/ext/missing/api.ts', undefined, resolve, outside),
    ).rejects.toThrow('no extension named missing is installed')
    await expect(
      resolveModuleName(root, '@ultimate/lib/none.ts', undefined, async () => null),
    ).rejects.toThrow(`${join(root, 'lib/none.ts')} does not exist`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("resolves a name in the importer's clone, as a relative path does, and in the running root outside every clone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-module-names-'))
  try {
    const clone = join(root, 'other-clone')
    await mkdir(join(clone, 'lib'), { recursive: true })
    await writeFile(join(clone, 'lib/module-names.ts'), '')
    await mkdir(join(clone, 'extensions/system'), { recursive: true })
    const resolve = async (file: string) => ({ id: file })
    const importer = join(clone, 'extensions/system/server.ts?v=1')
    expect(await resolveModuleName(root, '@ultimate/lib/git.ts', importer, resolve)).toEqual({
      id: join(clone, 'lib/git.ts'),
    })
    expect(await resolveModuleName(root, '@ultimate/ext/system/api.ts', importer, resolve)).toEqual(
      { id: join(clone, 'extensions/system/api.ts') },
    )
    const user = join(root, 'home/.ultimate/extensions/alpha/server.ts')
    expect(await resolveModuleName(root, '@ultimate/lib/git.ts', user, resolve)).toEqual({
      id: join(root, 'lib/git.ts'),
    })
    expect(await resolveModuleName(root, '@ultimate/lib/git.ts', '\0virtual', resolve)).toEqual({
      id: join(root, 'lib/git.ts'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps core from importing an extension by name wherever it forbids the relative path', () => {
  const groups = (config.lint?.overrides ?? []).flatMap((override) => {
    const rule = override.rules?.['no-restricted-imports'] as
      | [string, { patterns: { group: string[] }[] }]
      | undefined
    return rule ? rule[1].patterns.map((pattern) => pattern.group) : []
  })
  const forbidden = groups.filter((group) => group.includes('**/extensions/**'))
  expect(forbidden.length).toBeGreaterThan(3)
  for (const group of forbidden) expect(group).toContain('@ultimate/ext/**')
})

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { cleanEnv, fauxServer, removeTemp, temp, until } from '../helpers.ts'

const run = promisify(execFile)
const homes: string[] = []
afterAll(async () => {
  for (const home of homes.splice(0)) await removeTemp(home)
})

/** Two user-root extensions that reach the core and each other only through `@ultimate/…` names. */
async function namedExtensions(home: string) {
  const root = join(home, '.ultimate/extensions')
  const files = {
    'alpha/api.ts': `/** Alpha: says hello. */
import { defineApi } from '@ultimate/shared/extension-api.ts'
/** The alpha service. */
export const Alpha = defineApi<{ hello(): string }>()('alpha')
`,
    'alpha/ui.tsx': `/** Alpha's browser contract. */
export const alphaLabel = 'alpha-ui-names-marker'
`,
    'alpha/server.ts': `import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { ConversationsApi } from '@ultimate/ext/conversations/api.ts'
import { modulePath } from '@ultimate/lib/module-names.ts'
import { Alpha } from './api.ts'
export default (host: ExtensionHost) => {
  host.implement(Alpha, { hello: () => \`\${ConversationsApi.name} \${modulePath('@ultimate/lib/probe.ts')}\` })
  return defineExtension({ name: 'alpha' })
}
`,
    'alpha/web.tsx': `import { modulePath } from '@ultimate/lib/module-names.ts'
import { useOverview } from '@ultimate/ext/conversations/ui.tsx'
export const AlphaProbe = () => <span>{modulePath('@ultimate/lib/alpha-web-marker.ts')}{typeof useOverview}</span>
`,
    'beta/server.ts': `import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '@ultimate/server/actions.ts'
import { Alpha } from '@ultimate/ext/alpha/api.ts'
export const actions = { which: async (_args: unknown, { host }: ActionContext) => host.need(Alpha).hello() }
export default defineExtension({ name: 'beta' })
`,
    'beta/web.tsx': `import { alphaLabel } from '@ultimate/ext/alpha/ui.tsx'
export const BetaProbe = () => <span>{alphaLabel}</span>
`,
  }
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }
  return { alpha: join(root, 'alpha'), beta: join(root, 'beta') }
}

it('loads server and web facets of user extensions that import the core and each other by name', async () => {
  const home = await temp('ultimate-extension-names-')
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  await namedExtensions(home)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const record = (name: string) => server.extensions.info().find((entry) => entry.name === name)
    await until(() => !!server.extensions.action('beta', 'which'))
    expect(record('alpha')?.server?.error).toBeUndefined()
    expect(record('beta')?.server?.error).toBeUndefined()
    expect(await server.extensions.invoke('beta', 'which', {}, new AbortController().signal)).toBe(
      'conversations lib/probe.ts',
    )

    // A page load builds the bundle; both web facets are in it, alpha's ui.tsx through beta's import.
    expect((await fetch(server.url)).ok).toBe(true)
    const manifest = JSON.parse(await readFile(join(home, 'state/web/manifest.json'), 'utf8'))
    const assets = join(home, 'state/web', manifest.id, 'assets')
    const scripts = await Promise.all(
      (await readdir(assets))
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFile(join(assets, file), 'utf8')),
    )
    const bundle = scripts.join('\n')
    expect(bundle).toContain('alpha-ui-names-marker')
    expect(bundle).toContain('@ultimate/lib/alpha-web-marker.ts')
  } finally {
    await server.close()
  }
})

it('type-checks user extensions that import the core and each other by name', async () => {
  const home = await temp('ultimate-extension-names-check-')
  homes.push(home)
  const { alpha, beta } = await namedExtensions(home)
  const { stdout } = await run(
    process.execPath,
    [resolve('scripts/check-extension.ts'), alpha, beta],
    { cwd: home, env: cleanEnv() },
  )
  expect(stdout).toContain('2 extension(s) type-check.')
})

it('runs a Node script that imports a built-in extension by name, with the names hook first', async () => {
  // scripts/restore.ts imports extensions/cloud/, whose files import the core by name; two positionals print the usage.
  const failed = await run(
    process.execPath,
    ['--import', './lib/node-names.ts', 'scripts/restore.ts', 'one', 'two'],
    { env: cleanEnv() },
  ).then(
    () => undefined,
    (error: { code: number; stderr: string }) => error,
  )
  expect(failed?.code).toBe(1)
  expect(failed?.stderr).toContain('Usage: pnpm restore')
})

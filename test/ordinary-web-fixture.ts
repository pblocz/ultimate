/**
 * The ordinary web application without the coding modules: an explicit inventory of the core folders and the generic
 * extensions, copied into a temporary source root. Workspaces, lineage, coding-workflow and dream are absent, with no
 * API-only copies, so an import of them fails instead of falling back to the original source.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { linkDependencies, temp } from './helpers.ts'

/** The core of the server and the web shell, with the generic definitions. */
export const ordinaryCore = ['agents', 'lib', 'server', 'shared', 'web']
export const ordinaryFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.web.json',
  'vite.config.ts',
]
/**
 * The Phase 2 server set, the generic web shell and settings, and what their real consumers need. No extension in it
 * imports or needs one that is left out (checked by the test that uses it).
 */
export const ordinaryExtensions = [
  'coding-tools',
  'models',
  'conversations',
  'subagents',
  'messages',
  'automations',
  'prompt',
  'agent',
  'sidebar',
  'onboarding',
  'documents',
  'notices',
  'secrets',
  'theme',
  'web',
]
export const omittedExtensions = ['workspaces', 'lineage', 'coding-workflow', 'dream']

/** Copy the inventory into a new folder under `parent`, trusted, with the repository's dependencies linked. */
export async function ordinarySource(parent: string) {
  await mkdir(parent, { recursive: true })
  const root = await temp('ordinary-source-', parent)
  for (const folder of ordinaryCore)
    await cp(resolve(folder), join(root, folder), { recursive: true })
  for (const file of ordinaryFiles) await cp(resolve(file), join(root, file))
  for (const name of ordinaryExtensions)
    await cp(resolve('extensions', name), join(root, 'extensions', name), {
      recursive: true,
      // An extension's tests are not part of it.
      filter: (path) => !path.slice(resolve('extensions', name).length).startsWith('/test'),
    })
  await linkDependencies(root)
  // As `sourceCopy`: optimize on page requests, not at boot, and ignore stale events replayed from the copy.
  const config = join(root, 'vite.config.ts')
  await writeFile(
    config,
    (await readFile(config, 'utf8'))
      .replace(
        'export default defineConfig({',
        "export default defineConfig({ cacheDir: '.vite-cache', optimizeDeps: { entries: [] }, server: { watch: { ignored: [(file) => file === fileURLToPath(import.meta.url)] } },",
      )
      .replace(
        'plugins: [react(), tailwindcss()],',
        "plugins: [react(), tailwindcss(), { name: 'test:lazy-deps', configResolved(config) { config.optimizeDeps.include = [] } }],",
      ),
  )
  new ProjectTrustStore(join(parent, '.ultimate')).set(root, true)
  return root
}

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Plugin } from 'vite-plus'
import { extensionModule, modulePath } from '../lib/module-names.ts'

/**
 * The Ultimate clone that holds `importer`: the nearest folder above it with `lib/module-names.ts`. A file outside
 * every clone, such as a user or project extension, belongs to `ultimateRoot`, the running one.
 */
function cloneOf(ultimateRoot: string, importer: string | undefined) {
  const file = importer?.split('?')[0]
  if (!file || !isAbsolute(file)) return ultimateRoot
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'lib/module-names.ts'))) return folder
    if (dirname(folder) === folder) return ultimateRoot
  }
}

/**
 * The file an `@ultimate/…` name `id` stands for (`lib/module-names.ts`), passed to `resolve` (the plugin context's
 * `this.resolve`, skipping itself), so a name and a relative path to one file give one module. A name resolves in the
 * clone that holds `importer`, as a relative path does, and in `ultimateRoot` for a file outside every clone. An
 * extension name resolves to that clone's built-in folder first; without one, to the folder `outside` finds for the
 * name. Undefined when `id` is no name, or names an extension that is no built-in and `outside` is missing; throws
 * when it names no file.
 */
export async function resolveModuleName<Resolved>(
  ultimateRoot: string,
  id: string,
  importer: string | undefined,
  resolve: (file: string) => Promise<Resolved | null>,
  outside?: (name: string) => Promise<string | undefined>,
) {
  const path = modulePath(id)
  if (path === undefined) return undefined
  const extension = extensionModule(path)
  const clone = cloneOf(ultimateRoot, importer)
  let file = join(clone, path)
  if (extension && !existsSync(join(clone, 'extensions', extension.name))) {
    // Without `outside`, another plugin may know the folder (`extensionModules` does).
    if (!outside) return undefined
    const folder = await outside(extension.name)
    if (!folder) throw new Error(`${id}: no extension named ${extension.name} is installed.`)
    file = join(folder, extension.file)
  }
  const found = await resolve(file)
  if (!found) throw new Error(`${id}: ${file} does not exist.`)
  return found
}

/**
 * Resolves the `@ultimate/…` names to the built-in files of the importer's clone, or of the clone at `ultimateRoot`,
 * for every Vite that loads `vite.config.ts`. The server and the web build also resolve them in `extensionModules`, which finds the
 * extensions that are no built-in.
 */
export function moduleNames(ultimateRoot: string): Plugin {
  return {
    name: 'ultimate:names',
    enforce: 'pre',
    resolveId(id, importer, options) {
      return resolveModuleName(ultimateRoot, id, importer, (file) =>
        this.resolve(file, importer, { ...options, skipSelf: true }),
      )
    },
  }
}

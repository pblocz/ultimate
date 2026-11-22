/**
 * The fixed names an extension imports the core and other extensions by, wherever its folder is:
 * `@ultimate/ext/<name>/<file>` for `extensions/<name>/<file>`, and `@ultimate/<folder>/<file>` for the core folders.
 * Vite, lint, the dependency graph and the type checker map them through this table.
 */

/** Each name prefix and the repository folder it stands for. */
export const modulePrefixes = {
  '@ultimate/ext/': 'extensions/',
  '@ultimate/lib/': 'lib/',
  '@ultimate/shared/': 'shared/',
  '@ultimate/server/': 'server/',
  '@ultimate/test/': 'test/',
  '@ultimate/scripts/': 'scripts/',
} as const

/** The scope every name starts with; nothing else in it resolves as a package. */
export const moduleScope = '@ultimate/'

/**
 * The repository-relative path `specifier` names, with any `?query` kept, or undefined when it is no name. Throws
 * for a specifier in the `@ultimate/` scope with an unknown prefix, without a file, or with a `.`/`..` segment.
 */
export function modulePath(specifier: string) {
  if (!specifier.startsWith(moduleScope)) return undefined
  const query = specifier.indexOf('?')
  const name = query === -1 ? specifier : specifier.slice(0, query)
  const prefix = (Object.keys(modulePrefixes) as (keyof typeof modulePrefixes)[]).find((key) =>
    name.startsWith(key),
  )
  if (!prefix)
    throw new Error(
      `${specifier} names no Ultimate module; use one of ${Object.keys(modulePrefixes).join(', ')}.`,
    )
  const segments = name.slice(prefix.length).split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new Error(`${specifier} must name a file inside ${modulePrefixes[prefix]}.`)
  if (prefix === '@ultimate/ext/' && segments.length < 2)
    throw new Error(`${specifier} must name a file of the extension: @ultimate/ext/<name>/<file>.`)
  return modulePrefixes[prefix] + segments.join('/') + (query === -1 ? '' : specifier.slice(query))
}

/** The extension and its file that a repository-relative path names, when it is `extensions/<name>/<file>`. */
export function extensionModule(path: string) {
  const [folder, name, ...file] = path.split('?')[0].split('/')
  return folder === 'extensions' && name && file.length ? { name, file: file.join('/') } : undefined
}

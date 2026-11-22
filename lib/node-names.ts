/**
 * Resolves the `@ultimate/…` names (`lib/module-names.ts`) to this clone's files for a script that Node runs without
 * Vite and that imports extension code, such as `scripts/restore.ts`. Load it first: `node --import ./lib/node-names.ts`.
 */
import { registerHooks } from 'node:module'
import { modulePath } from './module-names.ts'

const root = new URL('..', import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    const path = modulePath(specifier)
    return next(path === undefined ? specifier : new URL(path, root).href, context)
  },
})

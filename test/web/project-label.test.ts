import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../shared/protocol.ts'
import type { ExtensionRecord } from '../../web/src/sdk/registry.ts'
import { defineWebExtension, ProjectLabel, provide } from '../../web/src/sdk/types.ts'
import { worktreeLabel } from '../../extensions/workspaces/project-label.ts'

const state = vi.hoisted(() => ({
  records: [] as ExtensionRecord[],
  system: undefined as SystemInfo | undefined,
}))
// The real hooks connect to a server; the chip and the title need only the installed facets and the system info.
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useSystem: () => state.system,
  useStore: () => undefined,
}))
// The actions and the client connect to a server on import; the chip and the title never call them.
vi.mock('../../web/src/sdk/actions.ts', () => ({ actions: {} }))
vi.mock('../../web/src/sdk/client.ts', () => ({ api: {}, store: {}, uiState: {} }))
vi.mock('../../web/src/app/palette.tsx', () => ({ Shortcut: () => null }))
vi.mock('../../web/src/app/primitives.tsx', () => ({ sidebarWidthBeyondPhone: 0 }))
const { ProjectChip, ProjectTitle, projectName, projectTitle } =
  await import('../../web/src/app/titlebar.tsx')

const home = '/home/me'
const system = (root: string, name: string, persistence = `${home}/.ultimate/projects/x/state`) =>
  ({
    machine: { home },
    project: { root, name },
    persistence: { path: persistence },
  }) as SystemInfo
const checkout = `${home}/.ultimate/projects/app-0123abcd/worktrees/42`
const workspaces: ExtensionRecord = {
  name: 'workspaces',
  version: 1,
  loading: false,
  extension: defineWebExtension({ provides: [provide(ProjectLabel, worktreeLabel)] }),
}

it('names the project by its folder and name while no extension labels it', () => {
  state.records = []
  state.system = system(checkout, '42')
  expect(renderToStaticMarkup(createElement(ProjectTitle))).toBe(
    '~/.ultimate/projects/app-0123abcd/worktrees/42',
  )
  expect(renderToStaticMarkup(createElement(ProjectChip))).toContain('>42</span>')
  expect(projectTitle(system(`${home}/code/app`, 'app', '/tmp/state'))).toBe('preview · ~/code/app')
  expect(projectName(system(`${home}/code/ultimate`, 'ultimate'))).toBe('')
})

it('uses the label workspaces gives a branch checkout, without the shell parsing the path', () => {
  state.records = [workspaces]
  state.system = system(checkout, '42')
  expect(renderToStaticMarkup(createElement(ProjectTitle))).toBe('app #42')
  expect(renderToStaticMarkup(createElement(ProjectChip))).toContain('>app #42</span>')
  expect(projectName(system(checkout, '42'), { name: 'ultimate', suffix: '#42' })).toBe('#42')
  expect(worktreeLabel(`${home}/code/app`)).toBeUndefined()
})

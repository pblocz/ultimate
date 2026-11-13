import { configure } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import type { WorktreeService } from '../conversations/api.ts'
import type { WorkspaceService } from './api.ts'

/** The optional Git operations of child agents, using the same worktree service as the workspace tools. */
export function subagentWorktrees(
  workspaces: Pick<WorkspaceService, 'create' | 'get' | 'land' | 'discard'>,
): WorktreeService {
  return {
    defaultIsolation: (tools) =>
      ['edit', 'write'].some((tool) => !tools || tools.includes(tool)) ? 'worktree' : 'none',
    warning: async (cwd) =>
      (await git(cwd, 'status', '--porcelain'))
        ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
        : '',
    prepare: async (tx, id, { cwd, instructions }) => {
      const workspace = await workspaces.create(tx, id, cwd)
      await configure(tx, id, {
        instructions: `${instructions}\nWork only in ${workspace.path} on ${workspace.branch}, cut from ${workspace.base}. Commit your work on this branch with clear messages. Never push and never touch other checkouts.`,
      })
    },
    get: (id, caller) => workspaces.get(id, caller),
    land: (id, caller) => workspaces.land(id, caller),
    discard: (id, caller) => workspaces.discard(id, caller),
    uncommitted: async (id, caller) => {
      const workspace = await workspaces.get(id, caller)
      if (workspace?.state !== 'ready') return { files: [] }
      // Keep NUL-separated names untrimmed: the regular Git helper trims a leading space from a file name.
      const list = (...command: string[]) =>
        exec('git', [...command, '-z'], {
          cwd: workspace.path,
          maxBuffer: 1024 * 1024,
        }).then(({ stdout }) => stdout.split('\0').filter(Boolean))
      const files = [
        ...new Set([
          ...(await list('diff', '--cached', '--name-only')),
          ...(await list('diff', '--name-only')),
          ...(await list('ls-files', '--others', '--exclude-standard')),
        ]),
      ]
      return { path: workspace.path, files }
    },
  }
}

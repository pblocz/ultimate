import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { exec } from '@ultimate/lib/exec.ts'
import { git } from 'ultimate-project-git-support/run'
import type { ChildOperations } from '@ultimate/ext/subagents/api.ts'
import { ChannelError } from '@ultimate/shared/channel-host.ts'
import type { PersonaApplicationService } from '@ultimate/shared/persona-application.ts'
import type { WorkspaceService } from './api.ts'
import { Workspaces } from './workspaces.ts'
import type { workspaces as workspaceRuntime } from './workspaces.ts'
import type { Workspace } from './types.ts'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'

export const workspaceNotReady = (workspace: Workspace) =>
  `Workspace is ${workspace.state}: ${workspace.error ?? 'checkout is not ready'}`

const instructionsFor = (workspace: Workspace, instructions: string) =>
  `${instructions}\nWork only in ${workspace.path} on ${workspace.branch}, cut from ${workspace.base}. Commit your work on this branch with clear messages. Never push and never touch other checkouts.`

/** Apply worktree policy inside the persona caller's transaction. */
export function workspacePersona(
  workspaces: Pick<ReturnType<typeof workspaceRuntime>, 'create' | 'get' | 'ready'>,
  host: Pick<ExtensionHost, 'harness' | 'metadata'>,
): PersonaApplicationService {
  return {
    accepts: (requirement) => requirement === 'worktree',
    async apply(tx, id, input) {
      const { kind, requirement, cwd, instructions, definition } = input
      if (
        kind === 'chat-configure' &&
        (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]
      )
        throw new ChannelError('conflict', 'Change an isolated profile in a new conversation')
      const isolate =
        requirement === undefined
          ? kind === 'child-start' &&
            input.adhoc &&
            ['edit', 'write'].some((tool) => !definition?.tools || definition.tools.includes(tool))
          : requirement === 'worktree'
      if (!isolate) return undefined
      const warning =
        kind === 'child-start' && (await git(cwd, 'status', '--porcelain'))
          ? '\nWarning: parent has uncommitted changes; they are not in the worktree.'
          : undefined
      const workspace = await workspaces.create(tx, id, cwd)
      await configure(tx, id, { instructions: instructionsFor(workspace, instructions) })
      return warning
    },
    async refreshInstructions(tx, id, text) {
      const workspace = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)]
      return workspace ? instructionsFor(workspace, text) : text
    },
    async beforeSubmit(id, caller) {
      if (!(await workspaces.get(id, caller))) return
      if ((await host.harness().snapshot(host.metadata, id, caller))?.label !== 'chat') return
      await workspaces.ready(id, caller, true)
      const own = await workspaces.get(id, caller)
      if (own && own.state !== 'ready')
        throw new ChannelError('unavailable', workspaceNotReady(own))
    },
  }
}

/** Worktree details and operations used by the existing subagent tool routes. */
export function workspaceChildOperations(
  workspaces: Pick<WorkspaceService, 'get' | 'land' | 'discard'>,
): NonNullable<(typeof ChildOperations)['service']> {
  return {
    async describe(id, caller) {
      const workspace = await workspaces.get(id, caller)
      return (
        workspace && {
          workspace,
          text: `\nIsolate: ${workspace.path}\nBranch: ${workspace.branch}`,
        }
      )
    },
    async execute(action, id, caller) {
      if (action === 'land' || action === 'discard') return workspaces[action](id, caller)
      throw new Error(`Unknown child operation: ${action}`)
    },
    async stopped(id, caller) {
      const workspace = await workspaces.get(id, caller)
      if (workspace?.state !== 'ready') return ''
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
      return files.length ? `\nLeft uncommitted in ${workspace.path}: ${files.join(', ')}` : ''
    },
  }
}

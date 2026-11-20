import { realpath } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { obj } from '@earendil-works/pi-schema'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'

export default function self(host: ExtensionHost) {
  // Core, always on; the handle resolves the current provider at each call.
  const workspaces = host.need(WorkspacesApi)
  return defineExtension({
    name: 'self',
    // Maintenance guidance is the maintain-ultimate skill in skills/, which the prompt lists by name and description.
    tools: [
      defineTool({
        name: 'restart',
        description:
          'Restart the shared Ultimate host after authorized changes to server/, shared/ or its packages (patches/, pnpm-lock.yaml). Land an isolated workspace into the running clone first.',
        parameters: obj({}),
        // The target generation is memoized before the swap, so replay reports it without restarting again.
        replay: 'safe',
        async execute(_args, api, context): Promise<ToolExecutionResult> {
          const own = await workspaces.get(api.conversationId, context)
          if (
            own &&
            ((await realpath(own.source)) !== (await realpath(host.ultimateRoot)) ||
              !own.landed ||
              (await workspaces.git(host.ultimateRoot, 'status', '--porcelain')) ||
              (await workspaces.git(host.ultimateRoot, 'rev-parse', 'HEAD')) !== own.landed)
          ) {
            const error = `Restart refused: land your workspace into ${own.source} first`
            return {
              isError: true,
              details: { refused: true, error },
              output: [{ type: 'text', text: error }],
            }
          }
          const key = `restart:${api.taskId}`
          const done = await api.memo<{
            generation: number
            fromGeneration: number
            build: string
          }>(key, context)
          if (done && Number(process.env.ULTIMATE_GENERATION) !== done.generation)
            return {
              isError: true,
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: Number(process.env.ULTIMATE_GENERATION),
                fromBuild: done.build,
                toBuild: host.build().id,
                rolledBack: true,
                error: host.system().process.activationError ?? 'Activation failed',
              },
              output: [
                {
                  type: 'text',
                  text: `Restart failed during activation; rolled back to generation ${process.env.ULTIMATE_GENERATION}. ${host.system().process.activationError ?? ''}`,
                },
              ],
            }
          if (done)
            return {
              details: {
                fromGeneration: done.fromGeneration,
                toGeneration: done.generation,
                fromBuild: done.build,
                toBuild: host.build().id,
              },
              output: [
                {
                  type: 'text',
                  text: `Restarted. Now running generation ${process.env.ULTIMATE_GENERATION ?? done.generation} (pid ${process.pid}), build ${done.build} → ${host.build().id}.`,
                },
              ],
            }
          const error = await awaitWithContext(
            host.restart(async (generation) => {
              await api.memo(
                key,
                {
                  generation,
                  fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
                  build: host.build().id,
                },
                context,
              )
            }),
            context,
          )
          return {
            isError: true,
            details: {
              fromGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              toGeneration: Number(process.env.ULTIMATE_GENERATION ?? 1),
              fromBuild: host.build().id,
              toBuild: host.build().id,
              error,
            },
            output: [{ type: 'text', text: error }],
          }
        },
      }),
    ],
  })
}

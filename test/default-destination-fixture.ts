import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect } from 'vitest'
import { Standing } from '../extensions/subagents/api.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from './helpers.ts'

/** The full app without coding-workflow, with a resident that is not the coding coordinator. */
export async function defaultDestinationFixture() {
  const home = await temp('ultimate-default-destination-')
  try {
    const projectRoot = join(home, 'workspace')
    await mkdir(projectRoot)
    await mkdir(join(home, '.ultimate/agents'), { recursive: true })
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({
        summaryModel: 'unavailable/test',
        extensions: {
          disable: ['coding-workflow', 'supercoordinator'],
          enable: ['voice-live', 'push', 'keep-warm'],
        },
        defaultDestination: { kind: 'conversation', address: '@neutral' },
      }),
    )
    await writeFile(
      join(home, '.ultimate/agents/neutral.md'),
      '---\nname: neutral\ndescription: Test destination\nresident: true\nmodel: faux/faux-1\ntools: [todo]\n---\nReply briefly.\n',
    )
    await writeFile(
      join(home, '.ultimate/agents/voice.md'),
      '---\nname: voice\nmodel: faux/faux-1\n---\n',
    )
    await mkdir(join(home, '.pi'))
    await writeFile(join(home, '.pi/settings.json'), '{"retry":{"baseDelayMs":1}}')
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot,
      home: join(home, 'state'),
      userHome: home,
    })
    try {
      const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
      expect(standing?.ultimate).toBeUndefined()
      expect(standing?.neutral).toBeTypeOf('number')
      const action = (name: string, args: unknown = null, conversationId?: ConversationId) =>
        post(server, `/api/extensions/${name.replace('.', '/actions/')}`, { args, conversationId })
      const chat = async () => {
        const response = await post(server, '/api/conversations')
        expect(response.status).toBe(201)
        return response.data.id as ConversationId
      }
      return {
        server,
        neutral: standing!.neutral,
        action,
        chat,
        projectRoot,
        home,
        close: async () => {
          try {
            await server.close()
          } finally {
            await removeTemp(home)
          }
        },
      }
    } catch (error) {
      await server.close()
      throw error
    }
  } catch (error) {
    await removeTemp(home)
    throw error
  }
}

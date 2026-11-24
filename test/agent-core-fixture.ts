/** A test-only server assembly over the real core and six retained server facets. */
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite-plus'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { prepareHarness, context } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import { loadExtensions } from '../server/extensions.ts'
import { createConversationHost } from '../server/conversation-host.ts'
import type { ConversationBackend } from '../server/conversation-host.ts'
import { createAccess } from '../server/request-security.ts'
import { extensionModules } from '../server/vite-extensions.ts'
import { emit } from '../server/events.ts'
import { writeProject } from '../server/project.ts'
import { ChannelError } from '../shared/channel-host.ts'
import { StartedEvent } from '../shared/events.ts'

export const agentCoreExtensions = [
  'coding-tools',
  'models',
  'conversations',
  'subagents',
  'messages',
  'automations',
] as const
const facets = {
  'coding-tools': ['api', 'refs', 'server'],
  models: ['api', 'fallback', 'families', 'refs', 'server'],
  conversations: [
    'activity',
    'api',
    'compactions',
    'context',
    'overview',
    'refs',
    'server',
    'summary-model-ref',
    'summary-model',
    'summary',
  ],
  subagents: ['api', 'children', 'destinations', 'refs', 'server'],
  messages: [
    'addresses',
    'api',
    'caller',
    'delivery',
    'images',
    'log',
    'questions',
    'refs',
    'send',
    'server',
  ],
  automations: [
    'api',
    'delivery',
    'destinations',
    'refs',
    'schedule',
    'scheduler',
    'server',
    'support',
    'triggers',
    'types',
  ],
}
const foundation = {
  server: [
    'actions',
    'build',
    'conversation-host',
    'conversation-configuration',
    'conversation-projection',
    'discovery',
    'events',
    'extension-apis',
    'extension-settings',
    'extensions',
    'harness',
    'http',
    'lock',
    'metadata',
    'models',
    'project-setup',
    'project',
    'request-security',
    'skills',
    'supervisor-protocol',
    'tool-arguments',
    'trace',
    'ui-state',
    'vite-extensions',
    'watch-roots',
  ],
  shared: [
    'channel-host',
    'conversation-configuration',
    'conversation-isolation',
    'events',
    'extension-api',
    'protocol',
    'source-status',
  ],
  lib: [
    'acting-as',
    'actions',
    'agents',
    'ago',
    'api-files',
    'chapters',
    'cloud',
    'commits',
    'context-usage',
    'entries',
    'exec',
    'families-settings',
    'families',
    'json-file',
    'marks',
    'message-state',
    'process-group',
    'schema',
    'secrets',
    'settings',
    'spawn',
    'steer',
    'title',
  ],
}
export const agentCoreFiles = [
  ...Object.entries(foundation).flatMap(([folder, files]) =>
    files.map((file) => `${folder}/${file}.ts`),
  ),
  ...Object.entries(facets).flatMap(([name, files]) =>
    files.map((file) => `extensions/${name}/${file}.ts`),
  ),
]
const repository = fileURLToPath(new URL('..', import.meta.url))

export async function agentCoreFixture(
  options: { root?: string; models?: { id: string; reasoning?: boolean }[] } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'ultimate-agent-core-')))
  const source = join(root, 'source')
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user')
  const home = join(root, 'state')
  for (const folder of [source, workspace, join(userHome, '.ultimate')])
    await mkdir(folder, { recursive: true })
  for (const file of agentCoreFiles) {
    const path = join(source, file)
    await mkdir(dirname(path), { recursive: true })
    await cp(join(repository, file), path)
  }
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n')
  if (!existsSync(join(source, 'node_modules')))
    await symlink(resolve(repository, 'node_modules'), join(source, 'node_modules'))
  await mkdir(join(source, 'agents'), { recursive: true })
  await writeFile(
    join(source, 'agents/neutral.md'),
    '---\nname: neutral\ndescription: Neutral file helper\nresident: true\ntools: [read, write]\nisolate: none\n---\nUse the shared workspace for ordinary tasks.\n',
  )
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    '{"summaryModel":"unavailable/test"}\n',
  )
  new ProjectTrustStore(join(userHome, '.ultimate')).set(workspace, true)
  const notices: string[] = []
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: workspace,
    userHome,
    home,
    faux: fauxProvider({ api: 'agent-core-faux', tokensPerSecond: 0, models: options.models }),
    report: (notice) => notices.push(notice.message),
  })
  const originalExtensions = join(repository, 'extensions') + '/'
  const vite = await createServer({
    configFile: false,
    root: source,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: join(root, 'vite'),
    plugins: [
      {
        name: 'test:agent-core-source-boundary',
        enforce: 'pre',
        load(id) {
          if (id.includes(originalExtensions))
            throw new Error(`Original extension source is forbidden: ${id}`)
        },
      },
      extensionModules(source, workspace, userHome),
    ],
  })
  let opened: OpenHost | undefined
  let backend: ConversationBackend | undefined
  const channel = () => {
    if (!backend) throw new ChannelError('unavailable', 'The test server is not open')
    return backend.channelHost
  }
  const extensions = await loadExtensions(
    vite,
    prepared,
    () => {},
    {
      access: createAccess(),
      harness: () => {
        if (!opened) throw new Error('The test harness is not open')
        return opened.harness
      },
      system: () => {
        throw new Error('This server-only fixture has no web system')
      },
      conversations: () => backend?.conversations() ?? [],
      channelHost: channel,
      watchWebEndpoint: () => () => {},
      webChannel: () => {
        throw new Error('This server-only fixture has no web channel')
      },
    },
    (attach) => attach(vite.watcher),
    (notice) => notices.push(notice),
  )
  async function open(response: FauxResponseFactory) {
    const respond: FauxResponseFactory = (...args) => {
      prepared.faux!.appendResponses([respond])
      return response(...args)
    }
    // Recovered work can start in resume: configure every model response before storage opens.
    prepared.faux!.setResponses([respond])
    await writeProject(home, workspace)
    opened = await prepared.open(false)
    await opened.harness.commit(
      (tx) =>
        emit(tx, StartedEvent, {
          generation: 1,
          build: prepared.build().id,
        }),
      context,
    )
    backend = await createConversationHost(prepared, opened, {
      configurationServices: extensions.configurationServices,
    })
    await extensions.opened()
    opened.harness.resume()
    backend.openAdmission()
    await extensions.ready()
    return channel()
  }
  async function release() {
    if (!opened) return
    backend?.closeAdmission()
    await extensions.released()
    await backend?.close()
    backend = undefined
    await opened.close()
    opened = undefined
  }
  let closed = false
  return {
    root,
    source,
    workspace,
    userHome,
    prepared,
    extensions,
    notices,
    open,
    release,
    get channel() {
      return channel()
    },
    get harness() {
      if (!opened) throw new Error('The test harness is not open')
      return opened.harness
    },
    loadedModules: () => [...vite.environments.ssr.moduleGraph.idToModuleMap.keys()],
    sourceText: (file: string) => readFile(join(source, file), 'utf8'),
    async close() {
      if (closed) return
      closed = true
      await release()
      await extensions.close()
      await vite.close()
    },
  }
}

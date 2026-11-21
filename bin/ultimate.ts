#!/usr/bin/env node
import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { runtimePaths } from '../server/project.ts'
import { acquireLock, readOwner, retireStorageOwner, pause } from '../server/lock.ts'
import { watch, existsSync } from 'node:fs'
import { watchRoots } from '../server/watch-roots.ts'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from '../shared/protocol.ts'
import type { ChildMessage, SupervisorMessage } from '../server/supervisor-protocol.ts'
import { isCoreReport } from '../server/supervisor-protocol.ts'
import type { CoreReport } from '../server/supervisor-protocol.ts'
import { dashboard } from './dashboard.ts'

const ultimateRoot = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const { values, positionals } = parseArgs({
  options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } },
  allowPositionals: true,
})
if (positionals.length > 1) throw new Error('Usage: ultimate [dir] [--port N] [--no-open]')
const opening = !values['no-open'] && process.env.ULTIMATE_NO_OPEN !== '1'
const available = (name: string) =>
  process.env.PATH?.split(':').some((path) => existsSync(join(path, name)))
/** Opens a chromeless app window, like an installed web app, in the first Chrome-family browser; else a tab. */
function openWindow(port: number) {
  const app = `http://ultimate.localhost:${port}`
  const tab = `http://127.0.0.1:${port}`
  let command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  let args = [tab]
  if (process.platform === 'darwin') {
    if (existsSync('/Applications/Google Chrome.app'))
      args = ['-na', 'Google Chrome', '--args', `--app=${app}`]
  } else if (available('omarchy-launch-webapp')) {
    command = 'omarchy-launch-webapp'
    args = [app]
  } else {
    const browser = [
      'google-chrome-stable',
      'google-chrome',
      'chromium',
      'chromium-browser',
      'brave',
      'brave-browser',
      'microsoft-edge',
      'vivaldi',
    ].find(available)
    if (browser) {
      command = browser
      args = [`--app=${app}`]
    }
  }
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' })
  opener.on('error', (error) => console.error(`Cannot open ${tab}: ${error.message}`))
  opener.unref()
}
const projectRoot = await realpath(positionals[0] ?? process.cwd()).catch((error) => {
  console.error(
    `Cannot open project ${positionals[0] ?? process.cwd()}: ${error.code ?? error.message}`,
  )
  process.exit(1)
})
const { userHome, home } = (() => {
  try {
    return runtimePaths(projectRoot)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return process.exit(1)
  }
})()
const requestedPort = values.port ?? process.env.ULTIMATE_PORT
if (requestedPort !== undefined && (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535))
  throw new Error('Invalid port')
/**
 * The web channel's port: the requested one, else the one the first core's web channel found from 4747. Each later
 * core binds the same port, so the URL stays across swaps and restarts. The supervisor itself listens on none.
 */
let port = requestedPort === undefined ? undefined : Number(requestedPort)
const lockPath = join(home, 'ultimate.lock')
await mkdir(home, { recursive: true })
const lock = await acquireLock(lockPath, {
  pid: process.pid,
  project: projectRoot,
}).catch(async (error) => {
  // Starting a running project again opens its window.
  const owner = opening && (await readOwner(lockPath))
  if (owner && owner.port !== undefined && String(error).includes('already running')) {
    openWindow(owner.port)
    process.exit(0)
  }
  console.error(String(error))
  process.exit(1)
})
// An interrupted `pnpm reset` or `pnpm restore` left the home half moved; storage must not open until it is finished.
if (existsSync(join(home, 'reset.json'))) {
  await lock.close()
  console.error(
    `A reset or restore of ${home} was interrupted. Rerun \`pnpm reset ${projectRoot}\` or \`pnpm restore --dir ${projectRoot}\`, then start Ultimate.`,
  )
  process.exit(1)
}
if (lock.stale) {
  try {
    await retireStorageOwner(join(home, 'storage.lock'))
  } catch (error) {
    await lock.close()
    throw error
  }
}
const display = dashboard(join(home, 'supervisor.log'))
process.on('exit', () => display.close())
let active: Core | undefined
let swapping = false
let stopping = false
let waiting = false
let failures = 0
let generation = 0
let announced = false
let stderr = ''
const children = new Set<Core>()
const tail = (text: string) => text.split('\n').slice(-200).join('\n')
/** The active core's web endpoint: the dashboard, the lock (project discovery) and, once, the browser window. */
let endpoint: string | undefined
let publishing = Promise.resolve()
function publish(report: CoreReport) {
  if (report.type !== 'web') return
  const url = report.state === 'ready' ? report.url : undefined
  if (url === endpoint) return
  endpoint = url
  display.url(url ?? '')
  if (url) port = Number(new URL(url).port)
  // Serialize lock updates. The same sidecar can lose and regain its port during a swap.
  publishing = publishing
    .then(() =>
      lock.update({
        pid: process.pid,
        ...(url ? { port: Number(new URL(url).port) } : {}),
        project: projectRoot,
      }),
    )
    .catch((error: unknown) =>
      display.log('error', 'supervisor', `Updating ${lockPath} failed: ${String(error)}`),
    )
    .finally(() => {
      if (!url || url !== endpoint) return
      display.log('info', 'supervisor', `Ultimate: ${url}`)
      if (!announced) {
        announced = true
        if (opening) openWindow(Number(new URL(url).port))
      }
    })
}
type Core = {
  child: ChildProcess
  generation: number
  stderr: string
  messages: ChildMessage[]
  reports: Map<'web' | 'access', CoreReport>
}
function wait(
  core: Core,
  type: ChildMessage['type'],
  requestId?: string,
  timeout = 60000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: ChildMessage) => {
      clearTimeout(timer)
      core.child.off('message', check)
      core.child.off('exit', exited)
      if (error) reject(error)
      else resolve(message!)
    }
    const check = () => {
      const index = core.messages.findIndex(
        (m) => m.type === type && (!requestId || ('requestId' in m && m.requestId === requestId)),
      )
      const failed = core.messages.find((m) => m.type === 'failed')
      if (failed?.type === 'failed') finish(new Error(failed.error))
      else if (index !== -1) finish(undefined, core.messages.splice(index, 1)[0])
    }
    const exited = () => finish(new Error(`Core exited before ${type}: ${core.stderr}`))
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${type}: ${core.stderr}`)),
      timeout,
    )
    core.child.on('message', check)
    core.child.once('exit', exited)
    check()
    if (core.child.exitCode !== null || core.child.signalCode !== null) exited()
  })
}
function send(core: Core, message: SupervisorMessage) {
  if (core.child.connected) core.child.send(message, () => {})
}
async function kill(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const exited = once(core.child, 'exit')
  core.child.kill('SIGKILL')
  await exited
}
async function exit(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const deadline = Date.now() + 10000
  try {
    const released = wait(core, 'released', undefined, 10000)
    send(core, { type: 'release' })
    await released
    const exited = once(core.child, 'exit')
    send(core, { type: 'exit' })
    await Promise.race([exited, pause(Math.max(0, deadline - Date.now()))])
  } catch {
    // A child that cannot release must be killed before another owner opens.
  } finally {
    await kill(core)
  }
}
function boot(previousBuild?: BuildInfo): Core {
  const child = fork(join(ultimateRoot, 'server/main.ts'), [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIMALLOC_ALLOW_THP: '0', // Avoid huge-page amplification in Rolldown's allocator.
      ULTIMATE_HOME: home,
      ULTIMATE_USER_HOME: userHome,
      ULTIMATE_PROJECT: projectRoot,
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_GENERATION: String(++generation),
      // Without a requested or found port, the child's web channel looks for a free one from 4747.
      ...(port === undefined ? {} : { ULTIMATE_PORT: String(port) }),
      ...(previousBuild ? { ULTIMATE_PREVIOUS_BUILD: JSON.stringify(previousBuild) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const core: Core = { child, generation, stderr: '', messages: [], reports: new Map() }
  display.lifecycle('preparing', { generation, pid: child.pid })
  children.add(core)
  child.stdout?.on('data', (chunk) => display.log('info', `core ${core.generation}`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    core.stderr = tail(core.stderr + chunk)
    stderr = tail(stderr + chunk)
    display.log('warn', `core ${core.generation}`, String(chunk))
  })
  child.on('error', (error) => {
    core.messages.push({ type: 'failed', error: String(error) })
  })
  child.on('message', (message: ChildMessage) => {
    if (isCoreReport(message)) {
      if (message.type === 'log') {
        display.log(message.level, `${message.source} · core ${core.generation}`, message.text)
      } else {
        core.reports.set(message.type, message)
        if (core === active) {
          display.report(message)
          publish(message)
        }
      }
      return
    }
    if (message.type === 'swap' && core === active) handleSwap(core, message)
    else core.messages.push(message)
  })
  child.on('exit', () => {
    children.delete(core)
    if (core === active && !swapping && !stopping) {
      active = undefined
      publish({ type: 'web', state: 'stopped' })
      display.lifecycle('crashed')
      display.log('error', 'supervisor', `Core ${core.generation} exited unexpectedly`)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
    }
  })
  return core
}
async function checkTypes() {
  display.lifecycle(
    'checking',
    active ? { generation: active.generation, pid: active.child.pid } : undefined,
  )
  const child = spawn(
    join(ultimateRoot, 'node_modules/.bin/tsc'),
    ['--noEmit', '-p', 'tsconfig.swap.json'],
    { cwd: ultimateRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output = tail(output + data)
    display.log('info', 'typecheck', String(data))
  })
  child.stderr.on('data', (data) => {
    output = tail(output + data)
    display.log('warn', 'typecheck', String(data))
  })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(output || `Type check exited ${code}`)
}
async function prepare(core: Core) {
  await wait(core, 'prepared')
}
function handleSwap(core: Core, message: Extract<ChildMessage, { type: 'swap' }>) {
  void swap(core, message.requestId, message.build).catch((error: unknown) =>
    display.log('error', 'supervisor', `Core swap failed: ${String(error)}`),
  )
}
/** Make `core` the active one: show its reports and publish its web endpoint, or that it has none. */
function activate(core: Core) {
  active = core
  display.lifecycle('ready', { generation: core.generation, pid: core.child.pid })
  for (const report of core.reports.values()) display.report(report)
  publish(core.reports.get('web') ?? { type: 'web', state: 'stopped' })
  // The listener can receive a restart request before the supervisor receives `ready`.
  core.messages = core.messages.filter((message) => {
    if (message.type !== 'swap') return true
    handleSwap(core, message)
    return false
  })
}
async function start(core: Core) {
  send(core, { type: 'go' })
  await wait(core, 'ready')
  if (stopping) {
    await kill(core)
    return
  }
  activate(core)
  failures = 0
  waiting = false
}
async function swap(old: Core, requestId: string, previousBuild?: BuildInfo) {
  if (swapping) {
    send(old, {
      type: 'swap-result',
      requestId,
      ok: false,
      error: 'A core swap is already in progress.',
    })
    return
  }
  swapping = true
  let next: Core | undefined
  let released = false
  try {
    await checkTypes()
    next = boot(previousBuild)
    await prepare(next)
    const ack = wait(old, 'swap-ack', requestId)
    send(old, { type: 'swap-result', requestId, ok: true, generation: next.generation })
    const acknowledgement = await ack
    if (acknowledgement.type === 'swap-ack' && !acknowledgement.ok)
      throw new Error(acknowledgement.error ?? 'Restart memo failed')
    active = undefined
    display.lifecycle('swapping')
    released = true
    const release = wait(old, 'released', undefined, 10000)
    send(old, { type: 'release' })
    await release
    publish({ type: 'web', state: 'stopped' })
    await start(next)
    await exit(old)
  } catch (error) {
    if (next) await kill(next)
    stderr = tail(String(error) + '\n' + (next?.stderr ?? ''))
    display.log('error', 'supervisor', stderr)
    if (!released && old.child.connected)
      send(old, { type: 'swap-result', requestId, ok: false, error: stderr })
    else {
      old.messages = old.messages.filter((message) => message.type !== 'failed')
      send(old, { type: 'reacquire', error: stderr })
      try {
        await wait(old, 'ready')
        activate(old)
      } catch {
        await kill(old)
        active = undefined
        publish({ type: 'web', state: 'stopped' })
      }
    }
  } finally {
    swapping = false
    if (active && (active.child.exitCode !== null || active.child.signalCode !== null))
      active = undefined
    if (active) {
      display.lifecycle('ready', { generation: active.generation, pid: active.child.pid })
      for (const report of active.reports.values()) display.report(report)
    }
    if (!active && !stopping)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
  }
}
let recovering = false
async function recover() {
  if (recovering || stopping) return
  recovering = true
  try {
    while (!active && failures < 3) {
      display.lifecycle(failures ? 'recovering' : 'starting')
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures))
      if (stopping) break
      let core: Core | undefined
      try {
        core = boot()
        await prepare(core)
        await start(core)
      } catch (error) {
        if (core) await kill(core)
        stderr = tail(String(error) + '\n' + (core?.stderr ?? ''))
        display.log('error', 'supervisor', stderr)
        failures++
      }
    }
    if (!active && !stopping) {
      // The supervisor log holds each boot failure; nothing is served until a change boots a core.
      waiting = true
      display.lifecycle('failed · waiting for changes')
    }
  } finally {
    recovering = false
  }
}
const retry = () => {
  if (waiting && !recovering && !stopping) {
    failures = 0
    waiting = false
    void recover().catch((error: unknown) =>
      display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
    )
  }
}
const watchers = ['server', 'shared', 'extensions'].map((directory) =>
  watch(join(ultimateRoot, directory), { recursive: true }, retry),
)
const projectConfig = join(projectRoot, '.ultimate')
let configWatcher: ReturnType<typeof watch> | undefined
const watchConfig = () => {
  configWatcher?.close()
  configWatcher = watch(projectConfig, { recursive: true }, retry)
  retry()
}
if (existsSync(projectConfig)) watchConfig()
const stopRoots = watchRoots([projectConfig], watchConfig)
async function shutdown() {
  if (stopping) return
  stopping = true
  display.lifecycle('stopping')
  stopRoots()
  configWatcher?.close()
  for (const watcher of watchers) watcher.close()
  await Promise.all([...children].map(exit))
  await publishing
  await lock.close()
  display.lifecycle('stopped')
  display.close()
  process.exit(0)
}
const stop = () => {
  void shutdown().catch((error: unknown) => {
    display.log('error', 'supervisor', `Shutdown failed: ${String(error)}`)
    process.exit(1)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await recover()

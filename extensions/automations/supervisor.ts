import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '@ultimate/server/extensions.ts'
import { discoverAgents, hostDefault } from '@ultimate/lib/agents.ts'
import { closeOutput, readPidFile, spawnGroup, stopGroup } from '@ultimate/lib/process-group.ts'
import type { Group } from '@ultimate/lib/process-group.ts'
import { readSecret, validateName } from '@ultimate/lib/secrets.ts'
import { SubagentsApi, SubagentsWorkflow } from '@ultimate/ext/subagents/api.ts'
import { Done, Escalated, Exited, Started } from './refs.ts'
import type { Automations as Ledger } from './server.ts'
import {
  doneText,
  FAILURE_LIMIT,
  fireText,
  isId,
  isSlug,
  STANDING,
  trimLog,
  WatcherLabel,
} from './types.ts'
import type { Manifest, Automation, Destination, Effect, Subscriber } from './types.ts'
import {
  automationRecord,
  MANIFEST,
  projectDirectory,
  runPath as scriptRunPath,
  scriptFolder,
  scriptsRoot as rootPath,
  supervisorState,
} from './support.ts'
import type { Prepared, ScriptProcess as Run } from './support.ts'
import type { Delivery, notifications } from './delivery.ts'

export { handshake as launchHandshake } from '@ultimate/lib/process-group.ts'
/** An hour of running before an exit means the script worked: its failure count starts again. */
const HEALTHY_MS = 3600_000
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
/** A project automation's committed manifest, or undefined when the file is missing or malformed. */
function manifest(value: unknown): Manifest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { name, ask, once, secrets, to, destination } = value as Record<string, unknown>
  if (typeof ask !== 'string' || !ask.trim()) return undefined
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined
  if (once !== undefined && typeof once !== 'boolean') return undefined
  if (to !== undefined && (typeof to !== 'string' || !STANDING.test(to))) return undefined
  if (to !== undefined && destination !== undefined) return undefined
  if (
    secrets !== undefined &&
    (!Array.isArray(secrets) || secrets.some((s) => typeof s !== 'string'))
  )
    return undefined
  return {
    name: name?.trim() ?? ask.trim().slice(0, 80),
    ask: ask.trim(),
    once: once ?? true,
    ...(secrets?.length ? { secrets: secrets as string[] } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(destination !== undefined ? { destination: destination as Destination } : {}),
  }
}

export function supervisor(
  host: ExtensionHost,
  Automations: typeof Ledger,
  fireAutomation: (tx: Tx, a: Automation, firedAt: number, text?: string) => Promise<unknown>,
  deliver: ReturnType<typeof notifications>['deliver'],
  checkSubscriber: (value: unknown) => Promise<Subscriber>,
) {
  // Only process state is reload-stable: running children and in-flight work. The functions below are rebuilt on each
  // install, so they always use the current ledger token and fire callback.
  // A new key: a process still holding the old `automations.supervisor` object (the whole supervisor) gets fresh
  // state on the first reload; the old facet's close stops its scripts and this one's open relaunches them.
  const shared = supervisorState(host)
  const { runs, launches, effects } = shared
  // home is the stable project state directory (~/.ultimate/projects/<name>-<hash>), not a worktree cwd. Ids restart in
  // each chapter, so a later chapter keeps its scripts apart as `<key>@<chapter>`, like its cloud backup; the first
  // chapter keeps the project key. Chapter and host restart together, so reading it here is stable.
  const scriptsRoot = () => rootPath(host)
  const folder = (id: string) => scriptFolder(host, id)
  const projectDir = (id: string) => projectDirectory(host, id)
  const runPath = (sub: Pick<Automation, 'id' | 'scope'>) => scriptRunPath(host, sub)
  const trusted = async () => (await host.projectSetup()).decision === true
  const configurationErrors = new Map<string, string>()
  const configurationError = (id: string, error: unknown) => {
    const message = `Automation ${id}: ${projectDir(id)}/${MANIFEST}: ${String(error)}`
    if (configurationErrors.get(id) !== message) host.notice(message)
    configurationErrors.set(id, message)
  }
  /** Keep file syntax separate from runtime defaults and locally saved recipients. */
  async function resolveManifest(m: Manifest, previous?: Automation, caller?: number) {
    const explicit =
      m.destination === undefined ? m.to : host.need(SubagentsApi).destinationAddress(m.destination)
    if (explicit !== undefined) {
      const address = await checkSubscriber(explicit)
      return { to: address, subscribers: [address] }
    }
    // Saved recipients are not checked again: delivery already skips a missing conversation.
    const stored = previous?.script?.to
    if (stored !== undefined) return { to: stored, subscribers: [stored] }
    if (previous?.subscribers.length) return { to: undefined, subscribers: previous.subscribers }
    const agents = host.need(SubagentsApi)
    const fallback = await agents.defaultDestination(BACKGROUND_CONTEXT)
    if (fallback !== undefined) {
      if (
        typeof fallback === 'string' &&
        !(await agents.residents(BACKGROUND_CONTEXT)).some(({ name }) => `@${name}` === fallback)
      )
        throw new Error(`Default destination ${fallback} is not a standing agent`)
      const address = await checkSubscriber(fallback)
      return { to: address, subscribers: [address] }
    }
    if (caller !== undefined) return { to: undefined, subscribers: [await checkSubscriber(caller)] }
    throw new Error(
      'A destination is required without a request conversation or default destination',
    )
  }
  /** Manifests under `<project>/.ultimate/automations/<slug>/`, only in a project chosen as local. */
  async function manifests() {
    const found = new Map<string, Manifest>()
    const present = new Set<string>()
    if (!(await trusted())) return { found, present }
    let entries: Dirent[]
    try {
      entries = await readdir(join(host.projectRoot, '.ultimate/automations'), {
        withFileTypes: true,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found, present }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSlug(entry.name)) continue
      let text: string
      try {
        text = await readFile(join(projectDir(entry.name), MANIFEST), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      present.add(entry.name)
      let parsed: Manifest | undefined
      try {
        parsed = manifest(JSON.parse(text))
        parsed?.secrets?.forEach(validateName)
      } catch {
        // Malformed JSON or a bad secret name is reported below like any other invalid manifest.
        parsed = undefined
      }
      if (parsed) found.set(entry.name, parsed)
      else configurationError(entry.name, `invalid ${MANIFEST}`)
    }
    return { found, present }
  }
  /**
   * Bring project records in line with the committed manifests: a new folder becomes a stopped automation that
   * never starts by itself, a changed manifest updates its fields, and a removed folder (or an untrusted project)
   * stops and forgets its record. The only place project records are made: a create publishes its manifest and
   * discovers it. A changed explicit target replaces the old one among subscribers; unresolved files keep their records.
   * Commits only when something changed.
   */
  async function discover(request?: { id: string; caller: number }) {
    const { found: files, present } = await manifests()
    const gone = (s: Automation) => s.scope === 'project' && !present.has(s.id)
    for (const id of configurationErrors.keys())
      if (!present.has(id)) configurationErrors.delete(id)
    const current =
      (await host.harness().snapshot(Automations, BACKGROUND_CONTEXT))?.automations ?? {}
    const found = new Map<
      string,
      { manifest: Manifest; target: Awaited<ReturnType<typeof resolveManifest>> }
    >()
    const prepared = new Map<string, Prepared>()
    for (const [id, m] of files) {
      try {
        const caller = request?.id === id ? request.caller : undefined
        const target = await resolveManifest(m, current[id], caller)
        if (!current[id]) prepared.set(id, await agentFor(caller))
        found.set(id, { manifest: m, target })
        configurationErrors.delete(id)
      } catch (error) {
        configurationError(id, error)
      }
    }
    const differs = (subs: Record<string, Automation>) =>
      [...found].some(([id, { manifest: m, target }]) => {
        const sub = subs[id]
        return (
          !sub ||
          (sub.scope === 'project' &&
            JSON.stringify([
              sub.name,
              sub.script!.ask,
              sub.script!.once,
              sub.script!.secrets,
              sub.script!.to,
            ]) !== JSON.stringify([m.name, m.ask, m.once, m.secrets, target.to]))
        )
      }) || Object.values(subs).some(gone)
    if (!differs(current)) return
    const trust = await trusted()
    const removed = await host.harness().commit(async (tx) => {
      const state = await tx.doc(Automations)
      const stops: Effect[] = []
      const now = Date.now()
      for (const [id, { manifest: m, target }] of found) {
        const sub = state.automations[id]
        const agent = prepared.get(id)
        if (!sub && agent)
          state.automations[id] = {
            id,
            scope: 'project',
            name: m.name,
            enabled: false,
            script: {
              ask: m.ask,
              once: m.once,
              ...(m.secrets ? { secrets: m.secrets } : {}),
              ...(target.to !== undefined ? { to: target.to } : {}),
              conversationId: await agentConversation(tx, agent, id, m.name),
              state: 'stopped',
            },
            subscribers: target.subscribers,
            runs: [],
            createdAt: now,
            updatedAt: now,
            fires: 0,
          }
        else if (sub?.scope === 'project') {
          const before = sub.script!.to
          if (target.to !== undefined)
            sub.subscribers = [
              ...new Set([...sub.subscribers.filter((s) => s !== before), target.to]),
            ]
          delete sub.script!.secrets
          delete sub.script!.to
          if (target.to !== undefined) sub.script!.to = target.to
          sub.name = m.name
          Object.assign(sub.script!, {
            ask: m.ask,
            once: m.once,
            ...(m.secrets ? { secrets: m.secrets } : {}),
          })
          sub.updatedAt = now
        }
      }
      for (const sub of Object.values(state.automations)) {
        if (!gone(sub)) continue
        // The scan may predate a manifest a create has since published: forget only what is still gone.
        if (trust && (await exists(join(projectDir(sub.id), MANIFEST)))) continue
        delete state.automations[sub.id]
        stops.push({
          id: sub.id,
          action: 'pause',
          ...(sub.script!.pid ? { previousPid: sub.script!.pid } : {}),
        })
      }
      return stops
    }, BACKGROUND_CONTEXT)
    for (const stop of removed) await apply(stop)
  }
  /** Create, inside `tx`, the ownerless conversation of automation `id`'s agent. */
  async function agentConversation(tx: Tx, prepared: Prepared, id: string, name: string) {
    const child = await host.need(SubagentsApi).createChild(tx, {
      owner: { kind: 'ownerless' },
      definition: prepared.profile,
      parentAgent: prepared.parent!,
      modelRuntime: host.modelRuntime,
      metadata: host.metadata,
      label: WatcherLabel,
      title: `${id} · ${name}`,
      cwd: host.projectRoot,
    })
    return child.id
  }
  /** Copy an explicit caller, an optional coding coordinator, or the current runtime defaults. */
  async function agentFor(caller?: number): Promise<Prepared> {
    const profile = (
      await discoverAgents(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        host.modelRuntime,
        undefined,
        host.projectAccess,
      )
    ).definitions.find((d) => d.name === 'watcher')
    if (!profile) throw new Error('Missing watcher agent definition')
    const coordinator =
      caller === undefined ? host.want(SubagentsWorkflow)?.coordinatorName?.() : undefined
    const parentId =
      caller ??
      (coordinator
        ? await host.need(SubagentsApi).standing(coordinator, BACKGROUND_CONTEXT)
        : ROOT_CONVERSATION_ID)
    const conversation = await host
      .harness()
      .conversation(parentId as ConversationId, BACKGROUND_CONTEXT)
    if (!conversation) throw new Error(`Unknown caller #${parentId}`)
    const parent = await conversation.agent(BACKGROUND_CONTEXT)
    return {
      profile,
      parent:
        caller === undefined && !coordinator ? { ...parent, ...(await hostDefault(host)) } : parent,
    }
  }
  /** What a watcher is told about its automation, at creation and on each failure. */
  const brief = (sub: Automation) =>
    [
      `You own automation ${sub.id} "${sub.name}".`,
      `Ask: ${sub.script!.ask}`,
      `Mode: ${sub.script!.once ? 'one-shot' : 'recurring'}`,
      `Named secret environment variables: ${sub.script!.secrets?.join(', ') || 'none'}`,
      `Executable: ${runPath(sub)}`,
      `Persistent memory: ${join(folder(sub.id), 'state')} ($AUTOMATION_STATE).`,
      ...(sub.scope === 'project'
        ? [
            `This is a project automation: run and ${MANIFEST} are committed in ${projectDir(sub.id)}, and run starts in ${host.projectRoot}. After you change run, say that the change is uncommitted in the project checkout.`,
          ]
        : []),
    ].join('\n')
  const snapshot = (id: string) => automationRecord(host, Automations, id)
  const tail = async (id: string, lines = 50) => {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
      throw new Error('lines must be 1–2000')
    try {
      return (await readFile(join(folder(id), 'output.log'), 'utf8'))
        .trimEnd()
        .split('\n')
        .slice(-lines)
        .join('\n')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
  /** The watcher's brief or failure report; undefined once its automation stopped, so nothing reaches the watcher. */
  async function deliveryContent(sub: Automation, kind: 'writing' | 'failed', text: string) {
    const now = (await host.harness().snapshot(Automations, BACKGROUND_CONTEXT))?.automations[
      sub.id
    ]
    const script = now?.script
    // A one-shot can be disabled while its watcher investigates an unplanned exit.
    if (
      !script ||
      script.conversationId !== sub.script?.conversationId ||
      script.state !== (kind === 'writing' ? 'writing' : 'investigating')
    )
      return undefined
    if (kind === 'writing') {
      await mkdir(join(folder(sub.id), 'state'), { recursive: true })
      return `${brief(sub)}\nWrite and briefly test run, then use automation resume {id:"${sub.id}"}. Ending your turn before resume or escalate escalates it.`
    }
    return `Automation ${sub.id} "${sub.name}" failed (${sub.script.failures ?? 1} of ${FAILURE_LIMIT} in a row; the ${FAILURE_LIMIT}rd escalates by itself): ${text}\nInvestigate, fix run, and use automation resume, or automation escalate with a clear reason when it cannot work. Ending your turn without resuming escalates it.\n${sub.scope === 'project' ? `${brief(sub)}\n` : ''}Last 50 log lines:\n${await tail(sub.id)}`
  }
  const readPid = (id: string) => readPidFile(join(folder(id), 'pid'))
  /** Pause, relaunch, delete, disable/release and shutdown all stop a script here: SIGTERM, three seconds, SIGKILL. */
  function cleanup(id: string, pid: number, run?: Run): Promise<void> {
    if (run?.cleanup) return run.cleanup
    const work = (async () => {
      // The pid file stays until the whole group is confirmed gone, and never names a replacement when removed.
      // A run's own group is identified by its unreaped leader, a crashed host's by its pid file.
      await stopGroup(pid, {
        pidFile: join(folder(id), 'pid'),
        leader: run?.group,
      }).catch((error: unknown) => {
        throw new Error(`Automation ${id}: ${String(error)}`)
      })
      if (run) await closeOutput(run.group)
      if (runs.get(id) === run) runs.delete(id)
    })()
    if (!run) return work
    run.cleanup = work.catch((error: unknown) => {
      // Keep the pid file and allow a later close/open to retry cleanup after a failed kill.
      delete run.cleanup
      throw error
    })
    return run.cleanup
  }
  /**
   * Inside `tx`: fail script `sub` for `reason`: it stops, its subscribers are woken and @ultimate is messaged. The
   * tool's escalate, the third failure in a row and a watcher that stops mid-repair all end here.
   */
  async function escalate(tx: Tx, sub: Automation, reason: string) {
    sub.enabled = false
    sub.script!.state = 'failed'
    sub.script!.error = reason
    sub.updatedAt = Date.now()
    const event = await host.emit(tx, Escalated, { id: sub.id, name: sub.name, reason })
    await deliver(tx, sub, event.id, 'escalated', reason)
  }
  async function finish(
    id: string,
    run: Run | undefined,
    code: number | null,
    signal?: string,
    error?: string,
  ) {
    if (run?.finished) return
    if (run) {
      run.finished = true
      run.active = false
    }
    if (run?.child.pid) await cleanup(id, run.child.pid, run)
    else if (run && runs.get(id) === run) runs.delete(id)
    if (shared.closing && !run) return
    await host.harness().commit(async (tx) => {
      const sub = (await tx.doc(Automations)).automations[id]
      if (!sub || (run && sub.script!.pid !== run.child.pid)) return
      const done = sub.script!.once && sub.script!.state === 'done'
      const stopped = !!run?.stopped || shared.closing
      if (!stopped && sub.script!.state !== 'running' && !done) return
      // A recurring script that printed DONE and exited 0 asked to stop: the same state as pause, with nobody woken.
      const said = run?.done
      const finished = !sub.script!.once && !stopped && !done && said !== undefined && code === 0
      // A fired one-shot is already done in its FIRE commit, so any other unplanned exit is a failure.
      // Shutdown keeps running automations enabled for reopen.
      const now = Date.now()
      const failed = !finished && !stopped && !done
      if (finished) {
        sub.script!.state = 'stopped'
        sub.enabled = false
      } else if (failed) {
        sub.script!.state = 'investigating'
        // A script that ran for an hour worked: this exit starts a new count.
        const healthy = !!sub.script!.startedAt && now - sub.script!.startedAt >= HEALTHY_MS
        sub.script!.failures = healthy ? 1 : (sub.script!.failures ?? 0) + 1
      }
      sub.updatedAt = sub.script!.exitedAt = now
      if (code !== null) sub.script!.exitCode = code
      delete sub.script!.pid
      const event = await host.emit(tx, Exited, {
        id,
        code,
        ...(signal ? { signal } : {}),
      })
      if (finished) await host.emit(tx, Done, { id, ...(said ? { text: said } : {}) })
      else if (sub.script!.state === 'done') sub.enabled = false
      else if (failed) {
        const reason = error ?? `Process exited with code ${code}${signal ? ` (${signal})` : ''}`
        if (sub.script!.failures! >= FAILURE_LIMIT)
          await escalate(tx, sub, `Failed ${sub.script!.failures} times in a row: ${reason}`)
        else {
          sub.script!.error = reason
          await deliver(tx, sub, event.id, 'failed', reason)
        }
      }
    }, BACKGROUND_CONTEXT)
  }
  async function stopProcess(id: string, pid?: number, reason: Run['stopped'] = 'pause') {
    // Receipts target the process present at mutation time, never a later start.
    if (!pid) return
    const run = runs.get(id)
    if (run && run.child.pid !== pid) return
    if (run) {
      run.stopped = reason
      run.active = false
      await cleanup(id, pid, run)
      await run.queue
    } else if ((await readPid(id)) === pid) await cleanup(id, pid)
  }
  async function launch(id: string, previousPid?: number) {
    const work = launchRun(id, previousPid)
    launches.add(work)
    try {
      await work
    } finally {
      launches.delete(work)
    }
  }
  async function launchRun(id: string, previousPid?: number) {
    const configuration = configurationErrors.get(id)
    if (configuration) throw new Error(configuration)
    if (shared.closing) throw new Error('Automation supervisor is closing')
    const sub = await snapshot(id)
    if (!sub.enabled || sub.script!.state !== 'running') return
    const current = runs.get(id)
    // A replay of a start receipt (including after onOpen reconciliation) reuses this process.
    if (
      current?.active &&
      current.child.pid === sub.script!.pid &&
      current.child.pid !== previousPid
    )
      return
    await stopProcess(id, current?.child.pid, 'restart')
    const recorded = await readPid(id)
    if (recorded) await cleanup(id, recorded)
    const dir = folder(id)
    await mkdir(join(dir, 'state'), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AUTOMATION_ID: id,
      AUTOMATION_STATE: join(dir, 'state'),
    }
    for (const name of sub.script!.secrets ?? []) {
      const value = await readSecret(host.userHome, name)
      if (!value) throw new Error(`Missing secret ${name}; add it in Secrets (⌘K → Secrets)`)
      env[name] = value
    }
    await access(runPath(sub), constants.X_OK)
    if (shared.closing) throw new Error('Automation supervisor is closing')
    let group: Group
    try {
      // The script waits behind the handshake until its pid file is written.
      group = spawnGroup(runPath(sub), [], {
        cwd: sub.scope === 'project' ? host.projectRoot : dir,
        env,
        pidFile: join(dir, 'pid'),
      })
    } catch (error) {
      throw new Error(`Automation ${id}: could not record its pid: ${String(error)}`, {
        cause: error,
      })
    }
    const { child } = group
    const run: Run = {
      child,
      group,
      active: true,
      afterFire: false,
      queue: Promise.resolve(),
    }
    runs.set(id, run)
    child.on('error', (error) => {
      run.error = error.message
    })
    child.on('close', (code, signal) => {
      enqueue(() => finish(id, run, code, signal ?? undefined, run.error))
    })
    // Hold output until the pid and Started event are committed, even for an immediately exiting script.
    run.queue = host.harness().commit(async (tx) => {
      const saved = (await tx.doc(Automations)).automations[id]
      if (!saved || !saved.enabled || saved.script!.state !== 'running') {
        run.active = false
        return
      }
      delete saved.script!.pid
      if (child.pid) {
        saved.script!.pid = child.pid
        saved.script!.startedAt = saved.updatedAt = Date.now()
        delete saved.script!.exitedAt
        delete saved.script!.exitCode
        delete saved.script!.error
        await host.emit(tx, Started, { id, pid: child.pid })
      }
    }, BACKGROUND_CONTEXT)
    function enqueue(work: () => Promise<void>) {
      run.queue = run.queue
        .then(work)
        .catch(async (error: unknown) => {
          host.notice(`Automation ${id}: ${String(error)}`)
          await finish(id, run, null, undefined, String(error))
        })
        .catch((error: unknown) => {
          // If storage itself failed, no durable recovery can be scheduled; retain a loud host diagnostic.
          host.notice(`Automation ${id} recovery could not be recorded: ${String(error)}`)
        })
    }
    async function line(text: string, stdout: boolean) {
      if (!run.active) return
      const path = join(dir, 'output.log')
      await appendFile(path, `${text}\n`)
      const output = await readFile(path, 'utf8')
      const trimmed = trimLog(output)
      if (trimmed !== output) await writeFile(path, trimmed)
      const fire = fireText(text, stdout)
      const done = doneText(text, stdout)
      if (done !== undefined) run.done = done
      await host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Automations)).automations[id]
        if (!saved || saved.script!.pid !== child.pid || saved.script!.state !== 'running') return
        saved.script!.lastOutputAt = saved.updatedAt = Date.now()
        if (fire === undefined || run.afterFire) return
        // A FIRE is the script doing its job: earlier failures no longer count toward escalation.
        delete saved.script!.failures
        await fireAutomation(tx, saved, Date.now(), fire)
        if (!saved.enabled) {
          run.stopped = 'pause'
          run.afterFire = true
        } else if (saved.script!.once) {
          saved.script!.state = 'done'
          saved.enabled = false
          run.afterFire = true
        }
      }, BACKGROUND_CONTEXT)
      if (run.afterFire && child.pid) {
        run.active = false
        await cleanup(id, child.pid, run)
      }
    }
    for (const [stream, stdout] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const) {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        let index: number
        while ((index = pending.indexOf('\n')) !== -1) {
          const text = pending.slice(0, index).replace(/\r$/, '')
          pending = pending.slice(index + 1)
          enqueue(() => line(text, stdout))
        }
        // Bound memory for scripts that produce output without newlines; only a complete line can FIRE.
        if (Buffer.byteLength(pending) > 256 * 1024) {
          const text = pending
          pending = ''
          enqueue(() => line(text, false))
        }
      })
      stream.on('end', () => {
        if (pending) enqueue(() => line(pending, stdout))
      })
    }
    await run.queue
    if (!run.active && !run.afterFire) await stopProcess(id, child.pid)
  }
  async function effect(value: Effect) {
    if (value.action === 'resume') {
      try {
        await launch(value.id, value.previousPid)
      } catch (error) {
        await finish(value.id, undefined, null, undefined, String(error))
        throw error
      }
    } else await stopProcess(value.id, value.previousPid)
  }
  async function apply(value?: Effect) {
    if (!value) return
    const previous = effects.get(value.id) ?? Promise.resolve()
    const work = previous.then(async () => {
      await effect(value)
    })
    // A failed start has already become an investigating automation; it must not block its repair.
    const settled = work.catch(() => {})
    effects.set(value.id, settled)
    try {
      await work
    } finally {
      if (effects.get(value.id) === settled) effects.delete(value.id)
    }
  }
  /**
   * A watcher gave its final answer. When its script is still being written or investigated and no input waits for
   * it, nobody would ever look again: escalate with its answer. A replay finds the script failed and does nothing.
   */
  async function watcherYielded(conversationId: number, answer: string) {
    await host.harness().commit(async (tx) => {
      const sub = Object.values((await tx.doc(Automations)).automations).find(
        (a) => a.script?.conversationId === conversationId,
      )
      if (!sub?.enabled || !['writing', 'investigating'].includes(sub.script!.state)) return
      if ((await tx.doc(InboxDoc, conversationId as ConversationId)).items.length) return
      // A brief or failure committed but not yet delivered is still coming: the watcher will look again.
      for (const live of ['pending', 'running'] as const) {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks(
            { kind: 'ultimate.automation-delivery', status: live },
            100,
            cursor,
          )
          if (
            page.items.some((task) =>
              (task.input as Delivery).targets.includes(sub.script!.conversationId),
            )
          )
            return
          cursor = page.next
        } while (cursor)
      }
      const said = answer.trim().split('\n')[0].slice(0, 200)
      await escalate(
        tx,
        sub,
        `The watcher stopped while the script was ${sub.script!.state}${said ? `: ${said}` : ''}`,
      )
    }, BACKGROUND_CONTEXT)
  }
  const close = async () => {
    shared.closing = true
    // A pending launch may be reading secrets or checking its executable; it must settle before cleanup.
    await Promise.allSettled(launches)
    for (const [id, run] of runs) await stopProcess(id, run.child.pid, 'shutdown')
  }
  const open = async () => {
    shared.closing = false
    let folders: Dirent[]
    try {
      folders = await readdir(scriptsRoot(), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      folders = []
    }
    // Sweep files, not ledger records: stop/delete may have committed just before a crash.
    for (const entry of folders) {
      if (!entry.isDirectory() || !isId(entry.name)) continue
      const pid = await readPid(entry.name)
      if (pid) await cleanup(entry.name, pid, runs.get(entry.name))
    }
    // Preserve records for bad configuration, but do not restart them until their file is usable.
    await discover()
    const state = await host.harness().snapshot(Automations, BACKGROUND_CONTEXT)
    for (const sub of Object.values(state?.automations ?? {})) {
      if (sub.script?.state !== 'running' || !sub.enabled || configurationErrors.has(sub.id))
        continue
      try {
        await launch(sub.id)
      } catch (error) {
        host.notice(`Automation ${sub.id}: ${String(error)}`)
        await finish(sub.id, undefined, null, undefined, String(error))
      }
    }
  }
  return {
    deliveryContent,
    apply,
    escalate,
    watcherYielded,
    open,
    close,
    discover,
    trusted,
    agentFor,
    projectDir,
    manifest,
    resolveManifest,
    configurationError: (id: string) => configurationErrors.get(id),
    agentConversation,
    tail,
  }
}

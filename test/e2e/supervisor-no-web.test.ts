import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceCopy, temp, until } from '../helpers.ts'
import { activationFailure, copies, homes, launch, listening } from './supervisor-helpers.ts'

/**
 * A channel over files, the way an extension without a listener reaches the runtime: each ready activation appends a
 * line to `probe.jsonl`; `probe-submit` submits its text to conversation 1; `probe-history` asks for that history.
 */
const probe = `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export default (host) => {
  const file = (name) => join(host.home, name)
  let timer
  host.onReady(async () => {
    const system = host.system().process
    appendFileSync(file('probe.jsonl'), JSON.stringify({ generation: system.generation, pid: process.pid, url: system.url ?? null, activationError: system.activationError ?? null }) + '\\n')
    clearInterval(timer)
    timer = setInterval(() => {
      if (existsSync(file('probe-submit'))) {
        const text = readFileSync(file('probe-submit'), 'utf8')
        rmSync(file('probe-submit'))
        host.channelHost().conversations.submit(1, { text }).catch((error) => appendFileSync(file('probe-errors'), String(error) + '\\n'))
      }
      if (existsSync(file('probe-history'))) {
        rmSync(file('probe-history'))
        host.channelHost().conversations.history(1, { direction: 'older' }).then(
          (page) => writeFileSync(file('probe-history.json'), JSON.stringify(page)),
          (error) => appendFileSync(file('probe-errors'), String(error) + '\\n'),
        )
      }
    }, 100)
  })
  const stop = async () => clearInterval(timer)
  host.onRelease(stop)
  host.onClose(stop)
  return { name: 'probe' }
}
`

it('starts, swaps, rolls back and stops without the web extension or any listening socket', async () => {
  const home = await temp('ultimate-supervisor-')
  homes.push(home)
  const root = await sourceCopy(home)
  await rm(join(root, 'web'), { recursive: true })
  await rm(join(root, 'extensions/web'), { recursive: true, force: true })
  await mkdir(join(root, 'extensions/probe'), { recursive: true })
  await writeFile(join(root, 'extensions/probe/server.ts'), probe)
  await writeFile(join(root, 'extensions/probe/README.md'), 'A file channel for tests.\n')
  copies.set(home, root)
  const running = await launch(home)
  const readies = async () =>
    (await readFile(join(home, 'probe.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            generation: number
            pid: number
            url: string | null
            activationError: string | null
          },
      )
  const history = async () => {
    await rm(join(home, 'probe-history.json'), { force: true })
    await writeFile(join(home, 'probe-history'), '')
    await until(() => existsSync(join(home, 'probe-history.json')))
    return readFile(join(home, 'probe-history.json'), 'utf8')
  }
  const lock = async () => JSON.parse(await readFile(join(home, 'ultimate.lock'), 'utf8'))

  await until(async () => (await readies()).length === 1)
  const [first] = await readies()
  expect(first).toMatchObject({ generation: 1, url: null })
  expect(await listening([running.child.pid!, first.pid])).toEqual([])
  expect((await lock()).port).toBeUndefined()

  await writeFile(join(home, 'probe-submit'), 'restart yourself')
  await until(async () => (await history()).includes('Restarted. Now running generation 2'))
  const second = (await readies()).at(-1)!
  expect(second).toMatchObject({ generation: 2, url: null })
  expect(second.pid).not.toBe(first.pid)
  expect(await listening([running.child.pid!, second.pid])).toEqual([])

  await activationFailure(root)
  await writeFile(join(home, 'probe-submit'), 'restart yourself')
  await until(async () =>
    (await history()).includes('Restart failed during activation; rolled back to generation 2'),
  )
  const rolledBack = (await readies()).at(-1)!
  expect(rolledBack).toMatchObject({ generation: 2, pid: second.pid })
  expect(rolledBack.activationError).toContain('Injected activation failure')
  expect(await listening([running.child.pid!, second.pid])).toEqual([])
  expect(existsSync(join(home, 'probe-errors'))).toBe(false)
  expect(running.output()).not.toContain('Ultimate: http')

  const exited = once(running.child, 'exit')
  running.child.kill('SIGTERM')
  expect((await exited)[0]).toBe(0)
  expect(() => process.kill(second.pid, 0)).toThrow('ESRCH')
}, 180000)

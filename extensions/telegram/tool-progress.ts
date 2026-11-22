import type { Address } from './channel.ts'

type Row = { label: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped' }
export type ProgressTransport = {
  post(address: Address, text: string, signal: AbortSignal): Promise<string>
  edit(chat: string, message: string, text: string, signal: AbortSignal): Promise<void>
}

export function toolProgress(
  from: Address,
  transport: ProgressTransport,
  signal: AbortSignal,
  posted: () => void,
  editDelay: () => number,
) {
  const rows = new Map<string, Row>()
  let message: string | undefined
  let lastText = ''
  let busy = false
  let failed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  const render = () => {
    const lines = [...rows.values()].slice(-8).map(({ label, status }) => `${label} · ${status}`)
    if (rows.size > 8) lines.unshift(`${rows.size - 8} earlier calls omitted`)
    return ['Tool activity', ...lines].join('\n')
  }
  const stop = () => {
    failed = true
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
  function schedule() {
    if (busy || failed || signal.aborted || !rows.size || render() === lastText) return
    clearTimeout(timer)
    const delay = message ? editDelay() : 0
    if (delay > 0) timer = setTimeout(schedule, delay)
    else void flush().catch(stop)
  }
  async function flush() {
    busy = true
    const text = render()
    try {
      if (message) await transport.edit(from.chat, message, text, signal)
      else {
        message = await transport.post(from, text, signal)
        posted()
      }
      lastText = text
    } catch {
      // The post may have succeeded. Do not create a replacement or retry an edit.
      stop()
    } finally {
      busy = false
      if (ended && render() === lastText) stop()
      else schedule()
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  return {
    update(key: string, row: Row, keepOutcome: boolean) {
      const prior = rows.get(key)
      if (
        !failed &&
        !ended &&
        !(keepOutcome && (prior?.status === 'done' || prior?.status === 'failed'))
      )
        rows.set(key, row)
    },
    flush: schedule,
    end() {
      ended = true
      for (const row of rows.values())
        if (row.status === 'running' || row.status === 'waiting') row.status = 'stopped'
      if (!rows.size || (!busy && render() === lastText)) stop()
      else schedule()
    },
  }
}

import { homedir } from 'node:os'

// Port of Nanobot's tool hints (nanobot/utils/tool_hints.py and nanobot/utils/path.py), with Ultimate's tool names.
const max = 40
type Format = { keys: string[]; template: string; path?: true; command?: true }
const formats: Record<string, Format> = {
  read: { keys: ['path', 'file_path'], template: 'read {}', path: true },
  write: { keys: ['path', 'file_path'], template: 'write {}', path: true },
  edit: { keys: ['path', 'file_path'], template: 'edit {}', path: true },
  bash: { keys: ['command'], template: '$ {}', command: true },
  powershell: { keys: ['command'], template: '$ {}', command: true },
  web_search: { keys: ['query'], template: 'search "{}"' },
  web_fetch: { keys: ['url'], template: 'fetch {}', path: true },
}
const pathInCommand =
  /"(?<double>(?:[A-Za-z]:[/\\]|~\/|\/)[^"]+)"|'(?<single>(?:[A-Za-z]:[/\\]|~\/|\/)[^']+)'|(?<bare>(?:[A-Za-z]:[/\\]|~\/|(?<=\s)\/)[^\s;&|<>"']+)/g

const record = (args: unknown): Record<string, unknown> =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
const firstString = (args: Record<string, unknown>) =>
  Object.values(args).find((value): value is string => typeof value === 'string' && !!value)
const cut = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value

function url(value: string, length: number) {
  if (value.length <= length) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return cut(value, length)
  }
  const segments = parsed.pathname.replace(/\/+$/, '').split('/')
  const basename = segments.at(-1) ?? ''
  if (!basename) return cut(value, length)
  let budget = length - parsed.host.length - basename.length - 4
  if (budget < 0) {
    const room = length - parsed.host.length - 5
    return `${parsed.host}/…/${room > 0 ? basename.slice(0, room) : ''}`
  }
  const kept: string[] = []
  for (const segment of segments.slice(0, -1).toReversed()) {
    if (segment.length + 1 > budget) break
    kept.unshift(segment)
    budget -= segment.length + 1
  }
  return `${parsed.host}/…/${kept.length ? `${kept.join('/')}/` : ''}${basename}`
}

export function abbreviatePath(value: string, length = max) {
  if (!value) return value
  if (/^https?:\/\//.test(value)) return url(value, length)
  let normalized = value.replaceAll('\\', '/')
  const home = homedir().replaceAll('\\', '/')
  if (normalized.startsWith(`${home}/`)) normalized = `~${normalized.slice(home.length)}`
  else if (normalized === home) normalized = '~'
  if (normalized.length <= length) return normalized
  const parts = normalized.replace(/\/+$/, '').split('/')
  if (parts.length <= 1) return cut(normalized, length)
  const basename = parts.at(-1)!
  let budget = length - basename.length - 3
  const kept: string[] = []
  for (const segment of parts.slice(0, -1).toReversed()) {
    if (segment.length + 1 > budget) break
    kept.unshift(segment)
    budget -= segment.length + 1
  }
  return `…/${kept.length ? `${kept.join('/')}/` : ''}${basename}`
}

function command(value: string, length: number) {
  const room = Math.max(Math.floor(length / 2), 25)
  const shortened = value.replace(
    pathInCommand,
    (_match, double?: string, single?: string, bare?: string) =>
      double !== undefined
        ? `"${abbreviatePath(double, room)}"`
        : single !== undefined
          ? `'${abbreviatePath(single, room)}'`
          : abbreviatePath(bare ?? '', room),
  )
  return cut(shortened, length)
}

/** One Nanobot-style hint for a tool call: the tool and its primary argument, shortened. */
export function toolPreview(name: string, input: unknown) {
  const args = record(input)
  const format = formats[name]
  let hint: string
  if (format) {
    const listed = format.keys.map((key) => args[key]).find((value) => Array.isArray(value))
    const value =
      format.keys.map((key) => args[key]).find((item) => typeof item === 'string' && item) ??
      (Array.isArray(listed) ? listed.find((item) => typeof item === 'string') : undefined) ??
      firstString(args)
    hint =
      typeof value !== 'string'
        ? name
        : format.template.replace(
            '{}',
            format.path
              ? abbreviatePath(value)
              : format.command
                ? command(value, max)
                : cut(value, max),
          )
  } else if (name === 'mcp' && typeof args.server === 'string') {
    const value = firstString(record(args.args))
    hint =
      typeof args.tool !== 'string'
        ? `${args.server}::tools`
        : value === undefined
          ? `${args.server}::${args.tool}`
          : `${args.server}::${args.tool}("${abbreviatePath(value)}")`
  } else {
    // Nanobot's fallback shows the first argument when it is text. Code keeps one line, as in Hermes.
    const value = Object.values(args)[0]
    const line = typeof value === 'string' ? value.split(/\s+/).join(' ').trim() : ''
    hint = line ? `${name}("${cut(line, max)}")` : name
  }
  // Telegram receives the hint as plain text. Remove control characters only.
  return hint.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() || 'tool'
}

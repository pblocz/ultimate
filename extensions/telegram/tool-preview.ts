import { isAbsolute, relative, resolve, sep } from 'node:path'

const files: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit' }
const secret =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|secrets?(\.[^/]*)?|credentials?(\.[^/]*)?|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|kdbx))$|(^|\/)(\.ssh|\.gnupg|\.aws|\.ultimate)(\/|$)/i
const clean = (text: string, limit: number) => {
  // Telegram renders this text. Remove control characters and keep each line short.
  const value = text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  return value.length > limit ? `…${value.slice(-(limit - 1))}` : value
}

/** A label for one tool call. It names the tool and at most one filtered detail; it never shows arguments or output. */
export function toolPreview(name: string, args: unknown, root: string) {
  const fields = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const file = files[name]
  if (file) {
    const path = 'path' in fields && typeof fields.path === 'string' ? fields.path : undefined
    if (!path || path.startsWith('~')) return file
    const shown = relative(root, resolve(root, path)).split(sep).join('/')
    if (!shown || shown.startsWith('..') || isAbsolute(shown) || secret.test(shown)) return file
    return `${file} · ${clean(shown, 60)}`
  }
  if (name === 'web_fetch') {
    const value = 'url' in fields ? fields.url : undefined
    const urls = (Array.isArray(value) ? value : [value]).filter((url) => typeof url === 'string')
    let host: string | undefined
    try {
      const url = new URL(urls[0] ?? '')
      if (url.protocol === 'https:' || url.protocol === 'http:') host = url.hostname
    } catch {
      // An invalid URL has no safe detail. Show only the tool name.
    }
    if (!host) return 'Web fetch'
    return `Web fetch · ${clean(host, 60)}${urls.length > 1 ? ` +${urls.length - 1}` : ''}`
  }
  if (name === 'bash') return 'Shell'
  return clean(name.replace(/[^A-Za-z0-9_.-]/g, ''), 60) || 'Tool'
}

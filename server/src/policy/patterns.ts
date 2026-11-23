const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const squash = (text: string) => text.trim().replace(/\s+/g, ' ')

/**
 * Whether a glob matches the whole text: `*` stands for any text and, when `single` is set, `?`
 * for one character. Greedy with one backtrack point, so it never takes more than pattern times
 * text steps, whatever the pattern or the call holds.
 */
export function wildcard(glob: string, text: string, single = false): boolean {
  let g = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (g < glob.length && (glob[g] === text[t] || (single && glob[g] === '?'))) {
      g += 1
      t += 1
    } else if (g < glob.length && glob[g] === '*') {
      star = g
      resume = t
      g += 1
    } else if (star === -1) {
      return false
    } else {
      g = star + 1
      resume += 1
      t = resume
    }
  }
  while (glob[g] === '*') {
    g += 1
  }
  return g === glob.length
}

/**
 * Whether a shell rule's pattern matches a command: `*` stands for any text, a trailing ` *` or
 * `:*` that is the only wildcard also matches the bare command, and no `*` means exactly.
 */
export function commandMatches(pattern: string, command: string): boolean {
  const rule = squash(pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern)
  const text = squash(command)
  if (!rule.includes('*')) {
    return rule === text
  }
  const stars = rule.split('*').length - 1
  if (stars === 1 && rule.endsWith(' *')) {
    const prefix = rule.slice(0, -2)
    return text === prefix || text.startsWith(`${prefix} `)
  }
  return wildcard(rule, text)
}

/** Whether a name glob, such as `mcp__*` or `get_*`, matches a whole name. */
export const nameMatches = (glob: string, name: string): boolean => wildcard(glob, name, true)

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

/**
 * Whether a `WebFetch(domain:...)` pattern matches the URL's host: `*` is every host, a leading
 * `*.` any depth of subdomain but not the domain itself, any other `*` one label.
 */
export function domainMatches(pattern: string, url: string): boolean {
  const host = hostOf(url)
  const rule = pattern.trim().toLowerCase().replace(/\.$/, '')
  if (host === null || rule === '') {
    return false
  }
  if (rule === '*') {
    return true
  }
  if (rule.startsWith('*.')) {
    const rest = rule.slice(2)
    return !rest.includes('*') ? host.endsWith(`.${rest}`) : false
  }
  return new RegExp(`^${rule.split('*').map(escape).join('[^.]*')}$`).test(host)
}

/** A parameter rule's value against the call's: `*` stands for any text, else exact. */
export function valueMatches(pattern: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return false
  }
  return wildcard(pattern, String(value))
}

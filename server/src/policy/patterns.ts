const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const squash = (text: string) => text.trim().replace(/\s+/g, ' ')

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
  return new RegExp(`^${rule.split('*').map(escape).join('.*')}$`, 's').test(text)
}

/** Whether a name glob, such as `mcp__*` or `get_*`, matches a whole name. */
export const nameMatches = (glob: string, name: string): boolean =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.split('?').map(escape).join('.'))
      .join('.*')}$`,
  ).test(name)

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
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's').test(String(value))
}

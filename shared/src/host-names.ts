import { parse } from 'tldts'

/** A word that may be dotted: a host, a file name, a path segment, a version or an identifier. */
const WORD = /[\w.-]+/g
/** A scheme and optional user just before a name, which make it the host of a URL. */
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?$/i
/** A name a path, a variable or a field access runs into, which is not a host. */
const PART_OF = /[/\\$%{]$/
/** Suffixes of private networks' names, which no public list holds. */
const PRIVATE = new Set(['internal', 'local', 'lan', 'localhost', 'corp', 'home.arpa'])
/**
 * Top-level domains that are also common file extensions or code words, so a bare `foo.sh`,
 * `build.zip` or `task.id` reads as a file or a field; with a scheme, port or path it is a host.
 */
const AMBIGUOUS = new Set([
  ...['zip', 'mov', 'sh', 'py', 'md', 'rs', 'pl', 'ps', 'so', 'cc'],
  ...['id', 'is', 'it', 'in', 'to', 'at', 'on', 'as', 'by', 'do', 'no', 'name'],
])

/** What surrounds a dotted word that shows it addresses a machine. */
interface Context {
  scheme: boolean
  /** A port (`:8080`), a path (`/x`) or a user (`git@`) goes with it. */
  addressed: boolean
}

/** A name with an underscore or a call after it is an identifier. */
const identifier = (name: string, after: string) => name.includes('_') || after.startsWith('(')

const EDGE = new Set(['.', '-'])

/** The dotted name in a word, without the dots and hyphens around it, and where it starts. */
function dottedIn(word: string): { name: string; offset: number } | null {
  let start = 0
  let end = word.length
  while (start < end && EDGE.has(word.charAt(start))) {
    start += 1
  }
  while (end > start && EDGE.has(word.charAt(end - 1))) {
    end -= 1
  }
  const name = word.slice(start, end)
  return name.includes('.') && !name.includes('..') ? { name, offset: start } : null
}

/** The host a dotted word names in its context, lower-cased, or null when it names none. */
function hostOf(name: string, context: Context): string | null {
  const host = name.toLowerCase()
  const parsed = parse(host, { allowPrivateDomains: true })
  if (parsed.isIp === true) {
    return host.split('.').every((part) => Number(part) <= 255) ? host : null
  }
  const suffix = parsed.publicSuffix ?? ''
  if (PRIVATE.has(suffix) || [...PRIVATE].some((end) => host.endsWith(`.${end}`))) {
    return host
  }
  if (parsed.domain === null || (parsed.isIcann !== true && parsed.isPrivate !== true)) {
    return context.scheme && /^[a-z]{2,}$/.test(suffix) ? host : null
  }
  return AMBIGUOUS.has(suffix) && !context.scheme && !context.addressed ? null : host
}

/**
 * The hosts a text names: IP addresses, names under a public or private-network suffix, and any
 * name a URL addresses. File names (`test-db.yaml`, `foo.sh`), paths, version numbers and dotted
 * identifiers are not hosts.
 */
export function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>()
  for (const match of text.matchAll(WORD)) {
    const dotted = dottedIn(match[0])
    if (dotted === null) {
      continue
    }
    const { name } = dotted
    const before = text.slice(0, match.index + dotted.offset)
    const after = text.slice(match.index + dotted.offset + name.length)
    const scheme = SCHEME.test(before)
    if (!scheme && (PART_OF.test(before) || identifier(name, after))) {
      continue
    }
    const addressed = /^(?::\d{1,5}\b|\/)/.test(after) || before.endsWith('@')
    const host = hostOf(name, { scheme, addressed })
    if (host !== null) {
      hosts.add(host)
    }
  }
  return hosts
}

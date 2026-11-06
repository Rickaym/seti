import { z } from 'zod'
import { hostRefusal, requestHost } from './change-requests.js'
import { hostMatches } from './connections.js'
import type { ModGrantScopes } from './mod-runtime.js'
import type { ModCapability } from './mods.js'
import { TEAM_HANDLE_MAX } from './team.js'

const IP_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Why a third-party mod may not name the host, or null; Seti's own names are checked at runtime. */
export function thirdPartyHostProblem(host: string): string | null {
  const name = host.replace(/^\*\./, '')
  if (IP_LITERAL.test(name)) {
    return `Name a host, not the address ${name}`
  }
  return hostRefusal(host)
}

/** A host a third-party mod may reach: a name, never an address, no wildcard over a public suffix. */
export const modHost = requestHost.superRefine((host, ctx) => {
  const problem = thirdPartyHostProblem(host)
  if (problem !== null) {
    ctx.addIssue({ code: 'custom', message: problem })
  }
})

/** Whether a granted host list covers the host; `*.example.com` covers subdomains, not the apex. */
export const hostAllowed = (granted: readonly string[], host: string): boolean =>
  granted.some((pattern) => hostMatches(pattern, host.toLowerCase()))

const HANDLE = new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,${String(TEAM_HANDLE_MAX - 2)}}[a-z0-9])?$`)
const ROLE = /^role:[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/

/** One entry of an agent filter: a group chat handle such as builder, or role:<name>. */
export const modAgentEntry = z
  .string()
  .max(80)
  .refine((entry) => HANDLE.test(entry) || ROLE.test(entry), 'Name an agent by handle, or a role as role:<name>')

/** What Seti knows of an agent when it checks a filter. */
export interface FilteredAgent {
  /** Its group chat handle now, or null when it has none. */
  handle: string | null
  /** The name of its role pack, or null. */
  role: string | null
}

/** No filter, or an empty one, covers every agent; otherwise the handle or role must be listed. */
export function agentAllowed(filter: readonly string[] | undefined, agent: FilteredAgent): boolean {
  if (filter === undefined || filter.length === 0) {
    return true
  }
  const role = agent.role?.toLowerCase()
  return filter.some((entry) =>
    entry.startsWith('role:') ? entry.slice(5).toLowerCase() === role : entry === agent.handle,
  )
}

/** Glob characters a grant may use; no braces, classes or negation, so one matcher reads them all. */
const GLOB_CHARS = /^[A-Za-z0-9._\-/*?]+$/

/** Paths no grant may cover, whatever else it names: env files, git internals and key files. */
const SENSITIVE_PROBES = ['.env', 'config/.env', '.git/config', 'id.pem', 'certs/id.pem', 'a/b/id.pem']

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

const NAME = '(?!\\.)[^/]+'

/** `**` spans folders, `*` and `?` stay in one name, and neither starts a dot name by itself. */
function globRegex(glob: string): RegExp {
  const segments = glob.split('/')
  let source = ''
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1
    if (segment === '**') {
      source += last ? `${NAME}(?:/${NAME})*` : `(?:${NAME}/)*`
      return
    }
    const lead = segment.startsWith('*') || segment.startsWith('?') ? '(?!\\.)' : ''
    source += `${lead}${escape(segment).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}${last ? '' : '/'}`
  })
  return new RegExp(`^${source}$`)
}

/** Whether a relative path matches a grant's glob. */
export const globMatches = (glob: string, relative: string): boolean => globRegex(glob).test(relative)

/** Why a grant may not use the glob, or null when it may. */
export function globProblem(glob: string): string | null {
  if (glob === '**' || glob === '**/*') {
    return 'Name the files, such as notes/**/*.md'
  }
  if (!GLOB_CHARS.test(glob)) {
    return 'A path is letters, digits, . _ - / and the wildcards * and ?'
  }
  if (glob.startsWith('/') || glob.split('/').some((segment) => segment === '..' || segment === '')) {
    return 'A path is relative, with no .. and no empty folder'
  }
  const sensitive = SENSITIVE_PROBES.find((probe) => globMatches(glob, probe))
  return sensitive === undefined ? null : `It would cover ${sensitive}, which mods never read`
}

/** A path glob in a files.read grant. */
export const modGlob = z
  .string()
  .max(200)
  .superRefine((glob, ctx) => {
    const problem = globProblem(glob)
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem })
    }
  })

/** A link a mod's notification may open: one of Seti's own hash routes, otherwise Seti's home. */
export const modNotifyUrl = (url: string | undefined): string =>
  url !== undefined && url.startsWith('/#') && !/[\s\\]/.test(url) ? url : '/'

/** Whether a folder could hold a file some glob matches, so a listing may show it. */
export function globCouldContain(glob: string, dir: string): boolean {
  if (dir === '') {
    return true
  }
  const want = glob.split('/')
  const have = dir.split('/')
  for (const [i, part] of have.entries()) {
    const segment = want[i]
    if (segment === '**') {
      return !part.startsWith('.')
    }
    if (segment === undefined || i === want.length - 1 || !globMatches(segment, part)) {
      return false
    }
  }
  return true
}

/** The scope of each capability as granted, before any connection is bound. */
export function grantScopes(capabilities: readonly ModCapability[]): ModGrantScopes {
  const scopes: Record<string, unknown> = {}
  for (const capability of capabilities) {
    scopes[capability.name] = capability.name === 'connection' ? { ...capability, connectionId: null } : capability
  }
  return scopes
}

/** Whether a host list covers a pattern whole: a name it matches, or a wildcard inside one of its. */
const coversPattern = (list: readonly string[], pattern: string): boolean =>
  pattern.startsWith('*.')
    ? list.some((entry) => entry === pattern || (entry.startsWith('*.') && pattern.endsWith(entry.slice(1))))
    : hostAllowed(list, pattern)

/** The hosts both lists cover, so a connection's key goes only where the grant and the row agree. */
export function hostsWithin(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a.filter((host) => coversPattern(b, host)), ...b.filter((host) => coversPattern(a, host))])]
}

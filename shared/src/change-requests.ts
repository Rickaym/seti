import { getDomain } from 'tldts'
import { z } from 'zod'
import { connectionEnv, connectionHost, connectionValue } from './connections.js'
import { isRecord, lenientArray, orDefault, type ResponseSchema } from './lenient.js'

/**
 * Changes an agent may ask the user for. Nothing else is requestable: the sandbox, Bypass,
 * permission modes and rules, security settings, secret values and other agents stay the user's.
 */
export const CHANGE_KINDS = ['allow_host', 'api_key', 'mcp_server'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** Who an allowed host reaches: the agent that asked, or every sandboxed agent. */
export const HOST_SCOPES = ['agent', 'all'] as const
export type HostScope = (typeof HOST_SCOPES)[number]

export const HTTPS_PORT = 443

const HOST_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/
const LOCAL_NAMES = ['localhost', '.localhost', '.local', '.internal', '.lan', '.home.arpa']

/** Loopback, private, shared and link-local IPv4 ranges: this machine and its networks. */
function internalIpv4(host: string): boolean {
  const match = IPV4.exec(host)
  if (match === null) {
    return false
  }
  const [a, b] = [Number(match[1]), Number(match[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** Why an agent may never ask for the host, or null when it may. */
export function hostRefusal(host: string): string | null {
  if (LOCAL_NAMES.some((name) => host === name.replace(/^\./, '') || host.endsWith(name))) {
    return 'Hosts on this machine or its local network are never requestable'
  }
  if (internalIpv4(host)) {
    return 'Loopback, private and link-local addresses are never requestable'
  }
  if (host.startsWith('*.') && !host.slice(2).includes('.')) {
    return 'A wildcard over a whole top-level domain is never requestable'
  }
  return host.startsWith('*.') ? suffixWildcardRefusal(host.slice(2)) : null
}

/** A wildcard over a public suffix, such as *.co.uk or *.github.io, reaches strangers' sites. */
function suffixWildcardRefusal(base: string): string | null {
  return getDomain(base, { allowPrivateDomains: true }) === null
    ? `Every site under ${base} belongs to someone else; name the host`
    : null
}

/** What makes a requested host broader than one name, for the card to show before Allow. */
export function hostFlags(host: string): string[] {
  return [
    ...(host.startsWith('*.') ? [`Wildcard: every subdomain of ${host.slice(2)}`] : []),
    ...(IPV4.test(host) ? ['An address, not a name: whatever runs there now'] : []),
  ]
}

export const requestHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOST_NAME, 'Use a host such as api.example.com or *.example.com, without a port')
  .superRefine((host, ctx) => {
    const refusal = hostRefusal(host)
    if (refusal !== null) {
      ctx.addIssue({ code: 'custom', message: refusal })
    }
  })

/** The change itself, exactly as it would apply; the agent never gives a secret value. */
export const requestedChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('allow_host'),
    host: requestHost,
    port: z.number().int().min(1).max(65_535).default(HTTPS_PORT),
  }),
  z.object({ kind: z.literal('api_key'), env: connectionEnv, hosts: z.array(connectionHost).min(1).max(5) }),
  z.object({ kind: z.literal('mcp_server'), server: z.string().trim().min(1).max(255) }),
])
export type RequestedChange = z.output<typeof requestedChange>

export const REQUEST_REASON_MAX = 500

export const fileChangeInput = z.object({
  change: requestedChange,
  reason: z.string().trim().min(10, 'Say in a sentence why you need it').max(REQUEST_REASON_MAX),
})
export type FileChangeInput = z.input<typeof fileChangeInput>
export type FileChangeRequest = z.output<typeof fileChangeInput>

/** The allowlist entry an allowed host request adds: always a host and one port. */
export const hostEntry = (change: Extract<RequestedChange, { kind: 'allow_host' }>) =>
  `${change.host}:${String(change.port)}`

/** The change in a few words, for reason lines, notes and the audit log. */
export function describeChange(change: RequestedChange): string {
  switch (change.kind) {
    case 'allow_host':
      return `access to ${hostEntry(change)}`
    case 'api_key':
      return `an API key ${change.env} for ${change.hosts.join(', ')}`
    case 'mcp_server':
      return `the MCP server ${change.server}`
  }
}

export const CHANGE_STATES = ['pending', 'allowed', 'denied', 'expired'] as const
export type ChangeState = (typeof CHANGE_STATES)[number]

/** A change an agent asked for, waiting on the user or answered. */
export interface ChangeRequest {
  id: string
  task_id: string
  change: RequestedChange
  /** The agent's own words for why it needs the change. */
  reason: string
  /** The credential the agent used when it asked, which a requested connection joins. */
  profile_id: string
  state: ChangeState
  /** What makes the change broad, for the card to show before Allow. */
  flags: string[]
  /** Where an allowed host went; null for other kinds and unanswered requests. */
  scope: HostScope | null
  created_at: string
  expires_at: string
  answered_at: string | null
}

/**
 * The user's answer. Allowing a connection request may carry the key the user pasted on the card;
 * it goes straight into the connection and never into the request, the audit log or the agent.
 */
export const answerChangeInput = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('allow'),
    scope: z.enum(HOST_SCOPES).default('agent'),
    value: connectionValue.optional(),
  }),
  z.object({ decision: z.literal('deny') }),
])
export type AnswerChangeInput = z.input<typeof answerChangeInput>

export const changeRequestParams = z.object({ id: z.string().trim().min(1).max(100), request_id: z.uuid() })

export const changeRequestSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  change: z.custom<RequestedChange>(
    (value) => isRecord(value) && (CHANGE_KINDS as readonly unknown[]).includes(value.kind),
    'an unknown change',
  ),
  reason: orDefault('reason', z.string(), ''),
  profile_id: orDefault('profile_id', z.string(), ''),
  state: orDefault<ChangeState>('state', z.enum(CHANGE_STATES), 'expired'),
  flags: orDefault('flags', z.array(z.string()), []),
  scope: orDefault<HostScope | null>('scope', z.enum(HOST_SCOPES).nullable(), null),
  created_at: z.string(),
  expires_at: z.string(),
  answered_at: orDefault('answered_at', z.string().nullable(), null),
}) satisfies ResponseSchema<ChangeRequest>

export const changeRequestsSchema = lenientArray('change request', changeRequestSchema)

/** A host the user allowed for one agent only, from a request or by hand. */
export const taskHostParams = z.object({
  id: z.string().trim().min(1).max(100),
  entry: z.string().trim().toLowerCase().max(260),
})

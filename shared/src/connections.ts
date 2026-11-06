import { z } from 'zod'

/**
 * A connection is one service's access for agents: its hosts, how Seti authenticates to it and
 * the sealed values that takes. Agents see a placeholder variable that the proxy swaps for the
 * value on the connection's hosts; a header template has the proxy add it on its own.
 */
export const CONNECTION_KINDS = ['key', 'client_credentials', 'refresh_token', 'jwt_bearer'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

/** The sealed values a connection can hold; which ones depend on its kind and settings. */
export const CONNECTION_SLOTS = [
  'value',
  'client_id',
  'client_secret',
  'private_key',
  'refresh_token',
  'key_file',
] as const
export type ConnectionSlot = (typeof CONNECTION_SLOTS)[number]

export const KIND_SLOTS: Record<ConnectionKind, readonly ConnectionSlot[]> = {
  key: ['value'],
  client_credentials: ['client_id', 'client_secret', 'private_key'],
  refresh_token: ['refresh_token', 'client_id', 'client_secret', 'private_key'],
  jwt_bearer: ['key_file', 'private_key'],
}

/** What a header template puts the value or minted token in place of. */
export const VALUE_PLACEHOLDER = '{{value}}'

const NAME = /^[a-z][a-z0-9_]{1,62}$/

/** Names Seti keeps for its own secrets and poller references. */
const RESERVED_NAMES = new Set(['claude_oauth_token', 'github_agent_token'])

export const connectionName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(NAME, 'Use lowercase letters, digits and underscores, such as stripe')
  .refine((name) => !RESERVED_NAMES.has(name), 'That name belongs to Seti')

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** Hosts Seti authenticates itself; a connection cannot put another value on them. */
const RESERVED_HOSTS = ['anthropic.com', 'github.com', 'githubusercontent.com', 'claude.ai']

const reservedHost = (host: string) => {
  const bare = host.replace(/^\*\./, '')
  return RESERVED_HOSTS.some((domain) => bare === domain || bare.endsWith(`.${domain}`))
}

export const connectionHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOST, 'Use a host such as api.example.com or *.example.com')
  .refine((host) => !reservedHost(host), 'Seti adds the credentials for Anthropic and GitHub itself')

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,62}$/

/** Variables Seti or the sandbox set for every agent; a connection cannot take one. */
const RESERVED_ENV = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'PWD',
  'TMPDIR',
  'TERM',
  'LANG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_TERMINAL_PROMPT',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_PROMPT_DISABLED',
  'SSH_AUTH_SOCK',
  'XDG_RUNTIME_DIR',
])
const RESERVED_ENV_PREFIXES = ['SETI_', 'CLAUDE_', 'ANTHROPIC_', 'AWS_', 'GIT_CONFIG_', 'LD_', 'LC_']

export const reservedEnv = (name: string) =>
  RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))

export const connectionEnv = z
  .string()
  .trim()
  .regex(ENV_NAME, 'Use capitals, digits and underscores, such as ELEVENLABS_API_KEY')
  .refine((name) => !reservedEnv(name), 'Seti sets that variable itself')

/** `base`, or `base_2`, `base_3` and so on: the first that `free` accepts, within 63 characters. */
export function firstFree(base: string, free: (candidate: string) => boolean): string {
  if (free(base)) {
    return base
  }
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 58)}_${String(n)}`
    if (free(candidate)) {
      return candidate
    }
  }
}

/** A variable for a connection named `name`: the name in capitals, prefixed when Seti owns that. */
export function envFor(name: string): string {
  const upper = name.toUpperCase()
  return connectionEnv.safeParse(upper).success ? upper : `KEY_${upper}`.slice(0, 63)
}

const TOKEN_HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/** Headers a connection must not set: they belong to the connection or to Seti. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
])

export const headerName = z
  .string()
  .trim()
  .min(1, 'Name the header')
  .max(100)
  .regex(TOKEN_HEADER, 'Header names are letters, digits and !#$%&*+.^_|~-')
  .refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), 'That header belongs to the connection')

/** A header the proxy adds on the connection's hosts, with the value in place of {{value}}. */
export const connectionHeader = z.object({
  name: headerName,
  template: z
    .string()
    .trim()
    .max(500)
    .refine((text) => !/[\r\n\0]/.test(text), 'Templates are one line')
    .refine((text) => text.includes(VALUE_PLACEHOLDER), `The template must contain ${VALUE_PLACEHOLDER}`),
})
export type ConnectionHeader = z.infer<typeof connectionHeader>

export const CLIENT_AUTHS = ['client_secret_post', 'client_secret_basic', 'private_key_jwt', 'none'] as const
export type ClientAuth = (typeof CLIENT_AUTHS)[number]

const optionalText = z.string().trim().max(2048).nullable().default(null)

const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const RESERVED_PARAMS = new Set([
  'grant_type',
  'client_id',
  'client_secret',
  'client_assertion',
  'client_assertion_type',
  'refresh_token',
  'assertion',
  'scope',
])

/** How Seti mints a token for an OAuth connection; every secret is a slot, never a field here. */
export const mintSettingsInput = z.object({
  token_url: z.url({ protocol: /^https$/, error: 'The token URL must be https' }),
  /** The client id when it is not secret; otherwise the client_id slot holds it. */
  client_id: optionalText,
  client_auth: z.enum(CLIENT_AUTHS).default('client_secret_post'),
  key_id: optionalText,
  /** An Entra certificate's SHA-1 thumbprint, sent as x5t with private_key_jwt. */
  certificate_thumbprint: optionalText,
  /**
   * The iss of a signed JWT (RFC 7523), signed with the private_key slot; null for a Google key
   * file, which names its own issuer and key.
   */
  issuer: optionalText,
  /** Whom the JWT acts for: a user for domain-wide delegation, or the issuer when empty. */
  subject: optionalText,
  scope: optionalText,
  audience: optionalText,
  resource: optionalText,
  extra_params: z
    .record(z.string().regex(PARAM_NAME), z.string().max(1024))
    .default({})
    .refine((params) => Object.keys(params).length <= 20, 'At most 20 extra parameters')
    .refine(
      (params) => Object.keys(params).every((key) => !RESERVED_PARAMS.has(key)),
      'Extra parameters cannot replace the ones Seti sets',
    ),
})
export type MintSettings = z.output<typeof mintSettingsInput>

export const isMinted = (kind: ConnectionKind) => kind !== 'key'

/** The slots a connection needs set before it works, given its kind and mint settings. */
export function neededSlots(kind: ConnectionKind, mint: MintSettings | null): ConnectionSlot[] {
  if (kind === 'key') {
    return ['value']
  }
  if (kind === 'jwt_bearer') {
    return (mint?.issuer ?? null) === null ? ['key_file'] : ['private_key']
  }
  const needs: ConnectionSlot[] = kind === 'refresh_token' ? ['refresh_token'] : []
  if ((mint?.client_id ?? null) === null) {
    needs.push('client_id')
  }
  if (mint?.client_auth === 'private_key_jwt') {
    needs.push('private_key')
  } else if (mint?.client_auth !== 'none') {
    needs.push('client_secret')
  }
  return needs
}

const connectionBase = z.object({
  name: connectionName,
  kind: z.enum(CONNECTION_KINDS),
  env: connectionEnv,
  hosts: z.array(connectionHost).max(20).default([]),
  header: connectionHeader.nullable().default(null),
  mint: mintSettingsInput.nullable().default(null),
})

type ConnectionShape = z.output<typeof connectionBase>

function checkConnection(connection: ConnectionShape, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: string) => {
    ctx.addIssue({ code: 'custom', message, path: [path] })
  }
  if (connection.header !== null && connection.hosts.length === 0) {
    issue('A header needs at least one host', 'hosts')
  }
  if (connection.kind === 'key') {
    if (connection.mint !== null) {
      issue('A key has no token settings', 'mint')
    }
    return
  }
  if (connection.mint === null) {
    issue('Give the token URL', 'mint')
    return
  }
  if (connection.kind === 'client_credentials' && connection.mint.client_auth === 'none') {
    issue('Client credentials need a client secret or a private key', 'mint')
  }
}

/** A connection's settings; values go in through their slots and never come back. */
export const connectionInput = connectionBase.superRefine(checkConnection)
export type ConnectionInput = z.input<typeof connectionInput>
export type ConnectionRequest = z.output<typeof connectionInput>

export const CONNECTION_VALUE_MAX = 16_384

/** Keys, JSON key files and tokens alike: any text without NUL, up to 16 KiB. */
export const connectionValue = z
  .string()
  .min(1, 'Paste the value')
  .max(CONNECTION_VALUE_MAX, 'Values are at most 16 KiB')
  .refine((value) => !value.includes('\0') && value.trim() !== '', 'Paste the value')

export const connectionValueInput = z.object({ value: connectionValue })
export type ConnectionValueInput = z.input<typeof connectionValueInput>

const profileIds = z.array(z.string().min(1).max(64)).max(100)

/** A new connection in one step: its settings, any values and the credentials that carry it. */
export const connectionCreateInput = connectionBase
  .extend({
    values: z.partialRecord(z.enum(CONNECTION_SLOTS), connectionValue).default({}),
    profile_ids: profileIds.default([]),
  })
  .superRefine((connection, ctx) => {
    checkConnection(connection, ctx)
    const allowed = KIND_SLOTS[connection.kind]
    for (const slot of Object.keys(connection.values)) {
      if (!allowed.includes(slot as ConnectionSlot)) {
        ctx.addIssue({ code: 'custom', message: `A ${connection.kind} connection has no ${slot}`, path: ['values'] })
      }
    }
  })
export type ConnectionCreateInput = z.input<typeof connectionCreateInput>
export type ConnectionCreateRequest = z.output<typeof connectionCreateInput>

export const connectionProfilesInput = z.object({ profile_ids: profileIds })
export type ConnectionProfilesInput = z.input<typeof connectionProfilesInput>

export const connectionParams = z.object({ id: z.string().min(1).max(64) })
export const connectionSlotParams = z.object({ id: z.string().min(1).max(64), slot: z.enum(CONNECTION_SLOTS) })

/**
 * What a request asks for when an agent or flow needs a connection the user fills in later: a
 * key the agent sends, or one Seti adds as a bearer header. It starts with no value and no grant.
 */
export const connectionPlaceholderInput = z.object({
  name: connectionName,
  /** The variable the request asked for; derived from the name when absent. */
  env: connectionEnv.optional(),
  hosts: z.array(connectionHost).min(1, 'Name at least one host').max(20),
  adds_header: z.boolean().default(false),
})
export type ConnectionPlaceholderInput = z.input<typeof connectionPlaceholderInput>
export type ConnectionPlaceholderRequest = z.output<typeof connectionPlaceholderInput>

export interface ConnectionSlotStatus {
  slot: ConnectionSlot
  set: boolean
  updated_at: string | null
}

/** A connection as Settings shows it: its settings and which values are set, never a value. */
export interface Connection {
  id: string
  name: string
  kind: ConnectionKind
  env: string
  hosts: string[]
  header: ConnectionHeader | null
  mint: MintSettings | null
  slots: ConnectionSlotStatus[]
  /** Slots it needs before it works; empty when ready. */
  missing: ConnectionSlot[]
  /** The credentials that carry it, by id and name. */
  profiles: { id: string; name: string }[]
  /** Pollers that send its value. */
  pollers: string[]
  /** Why the last mint failed, without any value; null once one succeeds. */
  mint_error: string | null
  mint_checked_at: string | null
  created_at: string
  updated_at: string
}

/** A connection as a credential lists it. */
export interface ProfileConnection {
  id: string
  name: string
  env: string
  hosts: string[]
}

/** What a test mint reports: never the token, only whether it worked and what it grants. */
export interface MintTest {
  ok: boolean
  error: string | null
  expires_at: string | null
  scope: string | null
  token_type: string | null
}

export function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return pattern === host
}

import {
  envFor,
  firstFree,
  VALUE_PLACEHOLDER,
  type ConnectionKind,
  type ConnectionSlot,
  type MintSettings,
} from '@seti/shared'

/** A secret the user named before connections, without its value. */
export interface OldSecret {
  name: string
  env: string | null
  hosts: string[] | null
  placeholder: string | null
}

/** A header rule of a credential before connections; minter secrets are named secrets. */
export interface OldRule {
  profile_id: string
  kind: string
  hosts: string[]
  header: string
  template: string
  secret: string | null
  minter: Record<string, unknown> | null
  mint_error: string | null
  mint_checked_at: string | null
}

export interface OldState {
  secrets: OldSecret[]
  /** Which credentials showed each API key, by secret name. */
  grants: { profile_id: string; secret: string }[]
  rules: OldRule[]
  /** Secret names pollers send. */
  pollerRefs: string[]
}

export interface PlannedConnection {
  name: string
  kind: ConnectionKind
  env: string
  placeholder: string
  hosts: string[]
  header: { name: string; template: string } | null
  mint: MintSettings | null
  /** Each slot's named secret, by its bare name. */
  slots: Partial<Record<ConnectionSlot, string>>
  profiles: string[]
  mint_error: string | null
  mint_checked_at: string | null
  /** What it came from, for the audit entry. */
  from: string
}

const MINTED: readonly string[] = ['client_credentials', 'refresh_token', 'jwt_bearer']

/** Minter fields that named a secret, and the slot each becomes. */
const SECRET_FIELDS: readonly (readonly [string, ConnectionSlot])[] = [
  ['client_id_secret', 'client_id'],
  ['client_secret', 'client_secret'],
  ['private_key', 'private_key'],
  ['refresh_token', 'refresh_token'],
  ['service_account', 'key_file'],
]

const asText = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

function mintOf(minter: Record<string, unknown>): MintSettings {
  const auth = asText(minter.client_auth)
  const params = minter.extra_params
  return {
    token_url: asText(minter.token_url) ?? '',
    client_id: asText(minter.client_id),
    client_auth:
      auth === 'client_secret_basic' || auth === 'private_key_jwt' || auth === 'none' ? auth : 'client_secret_post',
    key_id: asText(minter.key_id),
    certificate_thumbprint: asText(minter.certificate_thumbprint),
    issuer: null,
    subject: asText(minter.subject),
    scope: asText(minter.scope),
    audience: asText(minter.audience),
    resource: asText(minter.resource),
    extra_params:
      typeof params === 'object' && params !== null && !Array.isArray(params)
        ? Object.fromEntries(
            Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : {},
  }
}

const valueTemplate = (template: string) =>
  template.replaceAll('{{secret}}', VALUE_PLACEHOLDER).replaceAll('{{token}}', VALUE_PLACEHOLDER)

const slug = (host: string) => {
  const bare = host
    .split(/[^a-z0-9]/)
    .filter((part) => part !== '')
    .join('_')
  return /^[a-z]/.test(bare) ? bare : `h_${bare}`
}

/** Names and variables connections take, never one a named secret has unless it is that secret. */
class Names {
  private readonly secretNames: ReadonlySet<string>
  private readonly names = new Set<string>()
  private readonly envs = new Set<string>()

  constructor(secrets: readonly OldSecret[]) {
    this.secretNames = new Set(secrets.map((secret) => secret.name))
    for (const secret of secrets) {
      if (secret.env !== null && secret.placeholder !== null) {
        this.envs.add(secret.env)
      }
    }
  }

  has(name: string): boolean {
    return this.names.has(name)
  }

  /** `own` is the named secret the connection holds as its value, which may keep that name. */
  name(base: string, own: string | null): string {
    if (own !== null && !this.names.has(own)) {
      this.names.add(own)
      return own
    }
    const candidate = firstFree(base.slice(0, 60), (name) => !this.names.has(name) && !this.secretNames.has(name))
    this.names.add(candidate)
    return candidate
  }

  env(name: string): string {
    const candidate = firstFree(envFor(name), (env) => !this.envs.has(env))
    this.envs.add(candidate)
    return candidate
  }
}

const groupKey = (rule: OldRule) =>
  JSON.stringify([rule.kind, rule.secret, rule.hosts, rule.header, rule.template, rule.minter])

/** Rules that are the same in every respect but their credential become one connection. */
function groupRules(rules: readonly OldRule[]): OldRule[][] {
  const groups = new Map<string, OldRule[]>()
  for (const rule of rules) {
    const key = groupKey(rule)
    groups.set(key, [...(groups.get(key) ?? []), rule])
  }
  return [...groups.values()]
}

function minterSlots(minter: Record<string, unknown>, exists: (name: string) => boolean) {
  const slots: Partial<Record<ConnectionSlot, string>> = {}
  for (const [field, slot] of SECRET_FIELDS) {
    const name = asText(minter[field])
    if (name !== null && exists(name)) {
      slots[slot] = name
    }
  }
  return slots
}

const NO_MINT = { mint: null, mint_error: null, mint_checked_at: null }

function apiKeyConnections(old: OldState, names: Names): PlannedConnection[] {
  return old.secrets.flatMap((secret): PlannedConnection[] => {
    if (secret.env === null || secret.placeholder === null) {
      return []
    }
    const profiles = old.grants.filter((grant) => grant.secret === secret.name).map((grant) => grant.profile_id)
    return [
      {
        ...NO_MINT,
        name: names.name(secret.name, secret.name),
        kind: 'key',
        env: secret.env,
        placeholder: secret.placeholder,
        hosts: secret.hosts ?? [],
        header: null,
        slots: { value: secret.name },
        profiles,
        from: `API key ${secret.env}`,
      },
    ]
  })
}

interface Context {
  names: Names
  placeholder: (name: string) => string
  exists: (name: string) => boolean
}

function ruleConnection(group: readonly OldRule[], ctx: Context): PlannedConnection | null {
  const rule = group[0]
  if (rule === undefined) {
    return null
  }
  const profiles = [...new Set(group.map((entry) => entry.profile_id))]
  const header = { name: rule.header, template: valueTemplate(rule.template) }
  if (rule.kind === 'static' && rule.secret !== null) {
    const name = ctx.names.name(rule.secret, rule.secret)
    return {
      ...NO_MINT,
      name,
      kind: 'key',
      env: ctx.names.env(name),
      placeholder: ctx.placeholder(name),
      hosts: rule.hosts,
      header,
      slots: ctx.exists(rule.secret) ? { value: rule.secret } : {},
      profiles,
      from: `header rule ${rule.header} with ${rule.secret}`,
    }
  }
  const grant = asText(rule.minter?.grant)
  if (rule.minter === null || grant === null || !MINTED.includes(grant)) {
    return null
  }
  const name = ctx.names.name(slug(rule.hosts[0] ?? 'token'), null)
  return {
    name,
    kind: grant as ConnectionKind,
    env: ctx.names.env(name),
    placeholder: ctx.placeholder(name),
    hosts: rule.hosts,
    header,
    mint: mintOf(rule.minter),
    slots: minterSlots(rule.minter, ctx.exists),
    profiles,
    mint_error: rule.mint_error,
    mint_checked_at: rule.mint_checked_at,
    from: `minted header rule ${rule.header} (${grant})`,
  }
}

/** Named secrets a poller sends, or that nothing used, keep a connection of their own name. */
function standaloneConnections(old: OldState, ctx: Context): PlannedConnection[] {
  const inRules = new Set(old.rules.flatMap((rule) => [rule.secret, ...Object.values(rule.minter ?? {})]))
  return old.secrets.flatMap((secret): PlannedConnection[] => {
    const wanted = old.pollerRefs.includes(secret.name) || !inRules.has(secret.name)
    if (ctx.names.has(secret.name) || !wanted) {
      return []
    }
    const name = ctx.names.name(secret.name, secret.name)
    return [
      {
        ...NO_MINT,
        name,
        kind: 'key',
        env: ctx.names.env(name),
        placeholder: ctx.placeholder(name),
        hosts: [],
        header: null,
        slots: { value: secret.name },
        profiles: [],
        from: `named secret ${secret.name}`,
      },
    ]
  })
}

/**
 * Maps what Seti had before connections onto connections, one per API key, per distinct header
 * rule and per named secret a poller sends or nothing uses. Hosts are never merged: a key and a
 * rule on the same secret stay apart, and only rules alike in all but their credential share one.
 */
export function planConnections(old: OldState, placeholder: (name: string) => string): PlannedConnection[] {
  const names = new Names(old.secrets)
  const known = new Set(old.secrets.map((secret) => secret.name))
  const ctx: Context = { names, placeholder, exists: (name) => known.has(name) }
  const keys = apiKeyConnections(old, names)
  const rules = groupRules(old.rules).flatMap((group) => ruleConnection(group, ctx) ?? [])
  return [...keys, ...rules, ...standaloneConnections(old, ctx)]
}

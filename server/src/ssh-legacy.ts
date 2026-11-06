import { checkSshOption, type SshOption } from '@seti/shared'

/** One Host block of the free-text ssh config Seti kept before hosts and logins. */
interface LegacyBlock {
  aliases: string[]
  hostname: string | null
  user: string | null
  port: number | null
  jumps: string[]
  options: SshOption[]
  identityFiles: string[]
}

interface LegacyConfig {
  blocks: LegacyBlock[]
  /** Lines left out, as `alias: Keyword` or `line N: Keyword`, never with their value. */
  dropped: string[]
}

const ALIAS = /^\w[\w.-]{0,252}$/
const USER = /^[a-z_][\w.-]{0,31}$/i
const JUMP = /^(?:([a-z_][\w.-]{0,31})@)?(\w[\w.-]{0,252})(?::(\d{1,5}))?$/i

function splitLine(text: string): [string, string] {
  const at = text.search(/[\s=]/)
  if (at <= 0) {
    return [text, '']
  }
  const value = text.slice(at).trim()
  return [text.slice(0, at), (value.startsWith('=') ? value.slice(1) : value).trim()]
}

const portOf = (value: string) => {
  const port = Number(value)
  return /^\d{1,5}$/.test(value) && port >= 1 && port <= 65_535 ? port : null
}

type Fields = Partial<Pick<LegacyBlock, 'hostname' | 'user' | 'port' | 'jumps'>>

/** The fields Seti renders itself, each parsed from its value; null when the value is not usable. */
const FIELDS: Record<string, (value: string) => Fields | null> = {
  hostname: (value) => (ALIAS.test(value) ? { hostname: value } : null),
  user: (value) => (USER.test(value) ? { user: value } : null),
  port: (value) => {
    const port = portOf(value)
    return port === null ? null : { port }
  },
  proxyjump: (value) => {
    const jumps = value.toLowerCase() === 'none' ? [] : value.split(',').map((jump) => jump.trim())
    return jumps.every((jump) => JUMP.test(jump)) ? { jumps } : null
  },
}

function applyOption(block: LegacyBlock, keyword: string, value: string): { block: LegacyBlock; kept: boolean } {
  const key = keyword.toLowerCase()
  if (key === 'identityfile') {
    return { block: { ...block, identityFiles: [...block.identityFiles, value] }, kept: false }
  }
  if (value === '' || /[%"]/.test(value)) {
    return { block, kept: false }
  }
  const field = FIELDS[key]
  if (field !== undefined) {
    const fields = field(value)
    return { block: { ...block, ...fields }, kept: fields !== null }
  }
  const checked = checkSshOption(keyword, value)
  if (!checked.ok) {
    return { block, kept: false }
  }
  const options = [...block.options.filter((option) => option.name !== checked.option.name), checked.option]
  return { block: { ...block, options }, kept: true }
}

const emptyBlock = (aliases: string[]): LegacyBlock => ({
  aliases,
  hostname: null,
  user: null,
  port: null,
  jumps: [],
  options: [],
  identityFiles: [],
})

/** Reads the old config leniently: what Seti cannot keep is dropped and named, never fatal. */
export function parseLegacySshConfig(text: string): LegacyConfig {
  const blocks: LegacyBlock[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  let current: LegacyBlock | null = null
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim()
    const [keyword, value] = splitLine(trimmed)
    const key = keyword.toLowerCase()
    const where = `line ${String(index + 1)}`
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    if (key === 'host') {
      const words = value.split(/\s+/)
      const aliases = words.filter((alias) => ALIAS.test(alias) && !seen.has(alias.toLowerCase()))
      aliases.forEach((alias) => seen.add(alias.toLowerCase()))
      if (aliases.length < words.length) {
        dropped.push(`${where}: Host patterns or repeated aliases`)
      }
      current = emptyBlock(aliases)
      blocks.push(current)
    } else if (current === null || key === 'match') {
      current = null
      dropped.push(`${where}: ${keyword}`)
    } else {
      const applied = applyOption(current, keyword, value)
      Object.assign(current, applied.block)
      if (!applied.kept) {
        dropped.push(`${current.aliases[0] ?? where}: ${keyword}`)
      }
    }
  }
  return { blocks: blocks.filter((block) => block.aliases.length > 0), dropped }
}

/** A host entry the import creates, with the login Default gets for it. */
export interface PlannedHost {
  alias: string
  hostname: string
  port: number
  jump: string | null
  options: SshOption[]
  user: string
  /** The key of its login; null when Seti has no key at all. */
  keyId: string | null
}

export interface SshImportPlan {
  hosts: PlannedHost[]
  /** How each login's key was chosen when it was a guess, and other choices worth a look. */
  notes: string[]
  dropped: string[]
}

interface KeyRef {
  id: string
  name: string
}

interface Entry {
  alias: string
  hostname: string
  port: number
  jump: string | null
  options: SshOption[]
  user: string | null
  block: number
  specs: string[]
}

class Planner {
  readonly entries = new Map<string, Entry>()
  readonly jumpUsers = new Map<string, string>()
  readonly notes: string[] = []
  private blocks = 0

  constructor(config: LegacyConfig) {
    for (const block of config.blocks) {
      const id = this.blocks++
      for (const alias of block.aliases) {
        this.entries.set(alias.toLowerCase(), {
          alias,
          hostname: block.hostname ?? alias,
          port: block.port ?? 22,
          jump: null,
          options: block.options,
          user: block.user,
          block: id,
          specs: block.jumps,
        })
      }
    }
  }

  private freeAlias(base: string): string {
    let n = 1
    let alias = base
    while (this.entries.has(alias.toLowerCase())) {
      n += 1
      alias = `${base}-${String(n)}`
    }
    return alias
  }

  /** An entry for a hop no entry matches: a literal host, or an alias at another port. */
  private added(spec: string, name: string, port: number, known: Entry | undefined): Entry {
    const hostname = known?.hostname ?? name
    const same = [...this.entries.values()].find((entry) => entry.hostname === hostname && entry.port === port)
    if (same !== undefined) {
      return same
    }
    const alias = this.freeAlias(port === 22 ? name : `${name}-${String(port)}`)
    const block = this.blocks++
    const made: Entry = { alias, hostname, port, jump: null, options: [], user: null, block, specs: known?.specs ?? [] }
    this.entries.set(alias.toLowerCase(), made)
    this.notes.push(`${alias}: added as a host for the ProxyJump ${spec}`)
    return made
  }

  /** The entry a ProxyJump hop names, remembering the user the hop gave. */
  resolve(spec: string): Entry | null {
    const [, user, name = '', rawPort] = JUMP.exec(spec) ?? []
    if (name === '') {
      return null
    }
    const known = this.entries.get(name.toLowerCase())
    const port = rawPort === undefined ? (known?.port ?? 22) : Number(rawPort)
    const entry = known?.port === port ? known : this.added(spec, name, port, known)
    if (user !== undefined && !this.jumpUsers.has(entry.alias)) {
      this.jumpUsers.set(entry.alias, user)
    }
    return entry
  }

  link(): void {
    const pending = [...this.entries.values()]
    const chains: [Entry, Entry[]][] = []
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      const before = this.entries.size
      const hops = entry.specs.flatMap((spec) => this.resolve(spec) ?? [])
      pending.push(...[...this.entries.values()].slice(before))
      entry.jump = hops.at(-1)?.alias ?? null
      chains.push([entry, hops])
    }
    for (const [entry, hops] of chains) {
      for (const [index, hop] of hops.entries()) {
        const previous = hops[index - 1]
        if (previous === undefined || hop.jump === previous.alias) {
          continue
        }
        if (hop.jump === null) {
          hop.jump = previous.alias
        } else {
          this.notes.push(`${entry.alias}: kept ${hop.alias}'s own jump ${hop.jump} instead of ${previous.alias}`)
        }
      }
    }
    this.breakLoops()
  }

  private breakLoops(): void {
    for (const entry of this.entries.values()) {
      const trail = new Set([entry.alias])
      for (let hop = entry; hop.jump !== null;) {
        const next = this.entries.get(hop.jump.toLowerCase())
        if (next === undefined || trail.has(next.alias)) {
          this.notes.push(`${hop.alias}: dropped the jump ${hop.jump}, which loops`)
          hop.jump = null
          break
        }
        trail.add(next.alias)
        hop = next
      }
    }
  }
}

/** The key a block most likely used: named by IdentityFile, named after an alias, or a guess. */
function chooseKey(
  aliases: readonly string[],
  identityFiles: readonly string[],
  keys: readonly KeyRef[],
  claimed: ReadonlySet<string>,
): { key: KeyRef | null; guess: string | null } {
  const [first] = keys
  if (keys.length <= 1) {
    return { key: first ?? null, guess: null }
  }
  const lower = (text: string) => text.toLowerCase()
  const files = identityFiles.map((file) =>
    lower(
      file
        .split('/')
        .at(-1)
        ?.replace(/\.pub$/, '') ?? '',
    ),
  )
  const byFile = keys.find((key) => files.includes(lower(key.name)))
  if (byFile !== undefined) {
    return { key: byFile, guess: null }
  }
  const byName = keys.find((key) => aliases.some((alias) => lower(alias) === lower(key.name)))
  if (byName !== undefined) {
    return { key: byName, guess: `the key ${byName.name} is named after the host` }
  }
  const free = keys.filter((key) => !claimed.has(key.id))
  const [only] = free
  if (free.length === 1 && only !== undefined) {
    return { key: only, guess: `${only.name} is the only key not named after another host` }
  }
  return { key: first ?? null, guess: `no key is named after it, so it got the first key ${first?.name ?? ''}` }
}

/** Host entries from the old config, each with the user and key Default logs in with. */
export function planSshImport(text: string, keys: readonly KeyRef[], localUser: string): SshImportPlan {
  const config = parseLegacySshConfig(text)
  const planner = new Planner(config)
  planner.link()
  const entries = [...planner.entries.values()]
  const aliases = new Set(entries.map((entry) => entry.alias.toLowerCase()))
  const claimed = new Set(keys.filter((key) => aliases.has(key.name.toLowerCase())).map((key) => key.id))
  const notes = [...planner.notes]
  const keyOf = new Map<number, string | null>()
  for (const entry of entries) {
    if (keyOf.has(entry.block)) {
      continue
    }
    const siblings = entries.filter((other) => other.block === entry.block).map((other) => other.alias)
    const files = config.blocks.find((block) => block.aliases.includes(entry.alias))?.identityFiles ?? []
    const { key, guess } = chooseKey(siblings, files, keys, claimed)
    keyOf.set(entry.block, key?.id ?? null)
    if (guess !== null) {
      notes.push(`${siblings.join(', ')}: ${guess}`)
    }
  }
  const hosts = entries.map((entry) => {
    const jumpUser = planner.jumpUsers.get(entry.alias)
    if (jumpUser !== undefined && entry.user !== null && jumpUser !== entry.user) {
      notes.push(`${entry.alias}: logs in as ${entry.user}; a ProxyJump named the user ${jumpUser}`)
    }
    return {
      alias: entry.alias,
      hostname: entry.hostname,
      port: entry.port,
      jump: entry.jump,
      options: entry.options,
      user: entry.user ?? jumpUser ?? localUser,
      keyId: keyOf.get(entry.block) ?? null,
    }
  })
  return { hosts, notes, dropped: config.dropped }
}

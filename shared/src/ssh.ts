import { z } from 'zod'

/** Where a key's private half lives: sealed in the secret store, or a file on this machine. */
export type SshKeySource = 'generated' | 'imported' | 'file'

/** A key hosts select: its public half only, since the private one never leaves the server. */
export interface SshKey {
  id: string
  name: string
  type: string
  public_key: string
  fingerprint: string
  source: SshKeySource
  /** The private key file Seti reads, for a key of source file; null otherwise. */
  path: string | null
  /** The hosts that log in with it. */
  hosts: string[]
  created_at: string
  updated_at: string
}

/** A host key sandboxes trust, as a known_hosts line names it. */
export interface SshKnownHost {
  /** `host` for port 22, else `[host]:port`. */
  host: string
  key_type: string
  fingerprint: string
  accepted_at: string
}

/** An extra ssh_config option of a host, from the short list Seti allows. */
export interface SshOption {
  name: string
  value: string
}

/** A credential that bundles a host, so every agent using the set gets it. */
export interface SshHostSet {
  id: string
  name: string
}

/** A server agents may reach, the user ssh logs in as and the one key it logs in with. */
export interface SshHost {
  alias: string
  hostname: string
  port: number
  user: string
  /** Null only for a host carried over without a login; agents cannot use it until it has one. */
  key_id: string | null
  key_name: string | null
  /** The alias of the host ssh connects through first, or null for a direct connection. */
  jump: string | null
  options: SshOption[]
  /** Every agent without its own choice gets this host. */
  default_enabled: boolean
  /** The address, then the jump hosts in the order ssh connects: `10.0.0.9:22 via bastion`. */
  route: string
  /** The host:port the sandbox proxy lets ssh connect to for this host. */
  first_hop: string
  /** This host's name in known_hosts, whose trusted keys pin it. */
  known_name: string
  host_keys: SshKnownHost[]
  jump_for: string[]
  /** Credentials that bundle it. */
  sets: SshHostSet[]
  created_at: string
  updated_at: string
}

export interface SshStatus {
  hosts: SshHost[]
  keys: SshKey[]
  /** Trusted keys of addresses no host uses any more, to forget. */
  other_host_keys: SshKnownHost[]
}

/** A host key a scan found, to accept or not. */
export interface SshScannedKey {
  line: string
  host: string
  key_type: string
  fingerprint: string
  known: boolean
}

/** Whether ssh logged in to a host with its key, and what ssh said when it did not. */
export interface SshLogin {
  ok: boolean
  detail: string
}

/** A host check: the host keys it offers, to trust or not, and a login with the host's key. */
export interface SshCheck {
  alias: string
  keys: SshScannedKey[]
  login: SshLogin
}

const KEY_NAME = /^[\w .@-]{1,64}$/
const KEY_COMMENT = /^[\x21-\x7e][\x20-\x7e]{0,99}$/
const HOST_NAME = /^\w[\w.-]{0,252}$/
const USER_NAME = /^[a-z_][\w.-]{0,31}$/i
const NUMBER = /^\d{1,5}$/
const YES_NO = /^(?:yes|no)$/i
const ALGORITHMS = /^[+^-]?[\w@.-]{1,100}(?:,[\w@.-]{1,100}){0,30}$/

/** Options a host may add, by lowercase keyword: the name ssh spells and the values it takes. */
const SSH_OPTIONS: Readonly<Record<string, { name: string; value: RegExp }>> = {
  serveraliveinterval: { name: 'ServerAliveInterval', value: NUMBER },
  serveralivecountmax: { name: 'ServerAliveCountMax', value: NUMBER },
  connecttimeout: { name: 'ConnectTimeout', value: NUMBER },
  connectionattempts: { name: 'ConnectionAttempts', value: NUMBER },
  compression: { name: 'Compression', value: YES_NO },
  tcpkeepalive: { name: 'TCPKeepAlive', value: YES_NO },
  addressfamily: { name: 'AddressFamily', value: /^(?:any|inet|inet6)$/i },
  requesttty: { name: 'RequestTTY', value: /^(?:yes|no|force|auto)$/i },
  loglevel: { name: 'LogLevel', value: /^(?:quiet|fatal|error|info|verbose|debug[123]?)$/i },
  ciphers: { name: 'Ciphers', value: ALGORITHMS },
  macs: { name: 'MACs', value: ALGORITHMS },
  kexalgorithms: { name: 'KexAlgorithms', value: ALGORITHMS },
  hostkeyalgorithms: { name: 'HostKeyAlgorithms', value: ALGORITHMS },
  pubkeyacceptedalgorithms: { name: 'PubkeyAcceptedAlgorithms', value: ALGORITHMS },
}

export const SSH_OPTION_NAMES = Object.values(SSH_OPTIONS).map((option) => option.name)

const RUNS_COMMANDS = 'runs commands on this machine'
const FORWARDS = 'forwards sockets or connections'
const MANAGED = 'is managed by Seti'
const OWN_FIELD = 'has its own field'

/** Keywords refused with the reason that ends "it ..."; anything else not listed is unsupported. */
const REFUSED: Readonly<Record<string, string>> = {
  proxycommand: RUNS_COMMANDS,
  localcommand: RUNS_COMMANDS,
  remotecommand: RUNS_COMMANDS,
  permitlocalcommand: RUNS_COMMANDS,
  knownhostscommand: RUNS_COMMANDS,
  pkcs11provider: RUNS_COMMANDS,
  securitykeyprovider: RUNS_COMMANDS,
  match: RUNS_COMMANDS,
  include: 'reads other files',
  localforward: FORWARDS,
  remoteforward: FORWARDS,
  dynamicforward: FORWARDS,
  forwardagent: FORWARDS,
  forwardx11: FORWARDS,
  forwardx11trusted: FORWARDS,
  tunnel: FORWARDS,
  controlmaster: FORWARDS,
  controlpath: FORWARDS,
  controlpersist: FORWARDS,
  identityagent: MANAGED,
  identityfile: `${OWN_FIELD}: Key`,
  identitiesonly: MANAGED,
  certificatefile: MANAGED,
  userknownhostsfile: MANAGED,
  globalknownhostsfile: MANAGED,
  stricthostkeychecking: MANAGED,
  updatehostkeys: MANAGED,
  hostkeyalias: MANAGED,
  batchmode: MANAGED,
  setenv: 'passes environment to the host',
  sendenv: 'passes environment to the host',
  host: OWN_FIELD,
  hostname: OWN_FIELD,
  port: OWN_FIELD,
  proxyjump: `${OWN_FIELD}: Jump host`,
  user: `${OWN_FIELD}: User`,
}

export type SshOptionCheck = { ok: true; option: SshOption } | { ok: false; problem: string }

/** Checks one extra option: it with the keyword spelled as ssh does, or why it is refused. */
export function checkSshOption(name: string, value: string): SshOptionCheck {
  const key = name.trim().toLowerCase()
  const allowed = SSH_OPTIONS[key]
  if (allowed === undefined) {
    const reason = REFUSED[key]
    return {
      ok: false,
      problem: reason === undefined ? `${name} is not supported` : `${name} is not allowed: it ${reason}`,
    }
  }
  const trimmed = value.trim()
  return allowed.value.test(trimmed)
    ? { ok: true, option: { name: allowed.name, value: trimmed } }
    : {
        ok: false,
        problem: trimmed === '' ? `${allowed.name} needs a value` : `${allowed.name} ${trimmed} is not valid`,
      }
}

export const sshAlias = z
  .string()
  .trim()
  .regex(HOST_NAME, 'Name the host with letters, digits, dots, hyphens or underscores')

const hostname = z.string().trim().regex(HOST_NAME, 'Give a host name or IPv4 address, without user or port')

const options = z
  .array(z.object({ name: z.string().max(64), value: z.string().max(1000) }))
  .max(20, 'At most 20 options')
  .default([])
  .transform((list, ctx) => {
    const checked: SshOption[] = []
    for (const [index, entry] of list.entries()) {
      const result = checkSshOption(entry.name, entry.value)
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: result.problem, path: [index] })
      } else if (checked.some((option) => option.name === result.option.name)) {
        ctx.addIssue({ code: 'custom', message: `${result.option.name} is set twice`, path: [index] })
      } else {
        checked.push(result.option)
      }
    }
    return checked
  })

const sshUser = z.string().trim().regex(USER_NAME, 'Give a user name such as root or ubuntu')

const keyId = z.string({ error: 'Choose a key' }).trim().min(1, 'Choose a key').max(64)

/** A host's facts as the user sets them; its alias changes only through a rename. */
export const sshHostFields = z.object({
  hostname,
  port: z.coerce.number().int().min(1, 'Ports are 1 to 65535').max(65_535, 'Ports are 1 to 65535').default(22),
  user: sshUser,
  key_id: keyId,
  jump: sshAlias.nullable().default(null),
  options,
})
export type SshHostFields = z.input<typeof sshHostFields>
export type SshHostValues = z.output<typeof sshHostFields>

export const sshHostInput = sshHostFields.extend({ alias: sshAlias })
export type SshHostInput = z.input<typeof sshHostInput>

export const sshHostParams = z.object({ alias: sshAlias })

/** A host's new alias; its sets, the hosts jumping through it and agents' choices follow. */
export const sshHostRenameInput = z.object({ alias: sshAlias })

/** A host in a credential, by the set's id and the host's alias. */
export const sshSetHostParams = z.object({ id: z.string().min(1).max(64), alias: sshAlias })

export const sshKeyParams = z.object({ id: keyId })

export const sshKeyName = z.string().trim().regex(KEY_NAME, 'Name keys with letters, digits, spaces and .@_-')

/** The public key's trailing comment, as authorized_keys shows it; the key name when left empty. */
const sshKeyComment = z
  .string()
  .trim()
  .regex(KEY_COMMENT, 'Use up to 100 printable ASCII characters for the comment')
  .optional()
  .or(z.literal('').transform(() => undefined))

export const sshKeyCreateInput = z.object({ name: sshKeyName, comment: sshKeyComment })

const privateKey = z
  .string()
  .trim()
  .min(64, 'Paste the whole private key')
  .max(16_384)
  .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Paste an OpenSSH or PEM private key')

/** A private key file on this machine, as an absolute path or one under ~/. */
const keyPath = z
  .string()
  .trim()
  .max(4096)
  .regex(/^(?:\/|~\/)[^\0\n]+$/, 'Give the absolute path of a private key file, such as ~/.ssh/id_ed25519')

export const sshKeyImportInput = z.object({ name: sshKeyName, comment: sshKeyComment, private_key: privateKey })

export const sshKeyFileInput = z.object({ name: sshKeyName, path: keyPath })

/** Renames a key, or swaps its private half for a pasted key or a file; its hosts follow. */
export const sshKeyUpdateInput = z
  .object({ name: sshKeyName.optional(), private_key: privateKey.optional(), path: keyPath.optional() })
  .refine(
    (input) => input.private_key === undefined || input.path === undefined,
    'Paste a key or give a file, not both',
  )
export type SshKeyUpdateInput = z.input<typeof sshKeyUpdateInput>

export const sshAcceptInput = z.object({ lines: z.array(z.string().trim().min(1).max(16_384)).min(1).max(20) })

export const sshKnownHostQuery = z.object({ host: z.string().trim().min(1).max(300) })

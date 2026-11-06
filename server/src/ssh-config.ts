import type { SshHostRow } from './store/ssh.js'

export class SshHostError extends Error {}

type Hosts = ReadonlyMap<string, SshHostRow>

export const hostMap = (hosts: readonly SshHostRow[]): Map<string, SshHostRow> =>
  new Map(hosts.map((host) => [host.alias, host]))

/** The hosts a connection to `alias` passes, itself first, then each jump host outward. */
export function sshChain(hosts: Hosts, alias: string): SshHostRow[] {
  const chain: SshHostRow[] = []
  for (let host = hosts.get(alias); host !== undefined; host = host.jump === null ? undefined : hosts.get(host.jump)) {
    if (chain.includes(host)) {
      throw new SshHostError(`The jump hosts of ${alias} loop through ${host.alias}`)
    }
    chain.push(host)
  }
  return chain
}

const hostAddress = (host: Pick<SshHostRow, 'hostname' | 'port'>) => `${host.hostname}:${String(host.port)}`

/** The name known_hosts gives a host, lowercased: `host`, or `[host]:port` off port 22. */
export const knownName = (host: Pick<SshHostRow, 'hostname' | 'port'>) =>
  (host.port === 22 ? host.hostname : `[${host.hostname}]:${String(host.port)}`).toLowerCase()

/** Where the proxy lets ssh connect for a host: the address of the outermost host of its chain. */
export function firstHop(hosts: Hosts, alias: string): string {
  const outer = sshChain(hosts, alias).at(-1)
  return outer === undefined ? '' : hostAddress(outer)
}

/** `10.0.0.9:22 via bastion, inner`: the address, then the jump hosts in the order ssh connects. */
export function sshRoute(hosts: Hosts, alias: string): string {
  const [host, ...jumps] = sshChain(hosts, alias)
  if (host === undefined) {
    return ''
  }
  const via = jumps.map((jump) => jump.alias).toReversed()
  return via.length === 0 ? hostAddress(host) : `${hostAddress(host)} via ${via.join(', ')}`
}

export function checkJump(hosts: Hosts, alias: string, jump: string | null): void {
  if (jump === null) {
    return
  }
  if (jump === alias) {
    throw new SshHostError(`${alias} cannot jump through itself`)
  }
  const target = hosts.get(jump)
  if (target === undefined) {
    throw new SshHostError(`No ssh host ${jump} to jump through`)
  }
  if (sshChain(hosts, jump).some((host) => host.alias === alias)) {
    throw new SshHostError(`${jump} already connects through ${alias}, so the jump hosts would loop`)
  }
}

/** What an agent's ssh reaches: the hosts its access or set grants, with their jump hosts. */
export interface SshReach {
  enabled: string[]
  /** Enabled hosts whose whole chain has a key: the hosts the agent can use. */
  usable: string[]
  /** For every host, the hosts of its chain, itself first, without a key. */
  missing: Map<string, string[]>
  /** The usable hosts and the jump hosts on their way, each with its user and key. */
  hosts: SshHostRow[]
  /** Jump host to the usable hosts whose connection passes it. */
  jumpFor: Map<string, string[]>
  firstHops: string[]
  knownHosts: ReadonlySet<string>
}

/** The key ids the reached hosts log in with, each once. */
export const reachKeys = (hosts: readonly SshHostRow[]): string[] => [
  ...new Set(hosts.flatMap((host) => (host.key_id === null ? [] : [host.key_id]))),
]

/** Narrows the hosts to those granted whose chain has keys, with their jump hosts. */
export function sshReach(list: readonly SshHostRow[], enabled: readonly string[]): SshReach {
  const hosts = hostMap(list)
  const missing = new Map(
    list.map((host) => [
      host.alias,
      sshChain(hosts, host.alias)
        .filter((hop) => hop.key_id === null)
        .map((hop) => hop.alias),
    ]),
  )
  const on = list.map((host) => host.alias).filter((alias) => enabled.includes(alias))
  const usable = on.filter((alias) => missing.get(alias)?.length === 0)
  const reached = new Map<string, SshHostRow>()
  const jumpFor = new Map<string, string[]>()
  for (const alias of usable) {
    const [, ...jumps] = sshChain(hosts, alias)
    for (const hop of sshChain(hosts, alias)) {
      reached.set(hop.alias, hop)
    }
    for (const jump of jumps) {
      jumpFor.set(jump.alias, [...(jumpFor.get(jump.alias) ?? []), alias])
    }
  }
  const reach = list.filter((host) => reached.has(host.alias))
  return {
    enabled: on,
    usable,
    missing,
    hosts: reach,
    jumpFor,
    firstHops: [...new Set(usable.map((alias) => firstHop(hosts, alias)))],
    knownHosts: new Set(reach.map(knownName)),
  }
}

/** A host block with the public key file that picks its key from the agent. */
export interface RenderHost {
  host: SshHostRow
  keyFile: string
}

export interface SandboxSshPaths {
  /** socat and the task proxy's port; null when ssh connects directly, as for a scan. */
  proxy: { socat: string; port: number } | null
  knownHosts: string
  /** Blocks that come first and so win, such as a scan's relaxed host key check. */
  first?: string[]
}

function renderHost({ host, keyFile }: RenderHost): string[] {
  return [
    `Host ${host.alias}`,
    `  HostName ${host.hostname}`,
    `  Port ${String(host.port)}`,
    `  User ${host.user}`,
    `  IdentityFile ${keyFile}`,
    '  IdentitiesOnly yes',
    ...(host.jump === null ? [] : [`  ProxyJump ${host.jump}`]),
    ...host.options.map((option) => `  ${option.name} ${option.value}`),
  ]
}

/** A host that never answers fails in 10s, and a link that goes silent drops within a minute. */
const DEAD_LINK_LIMITS = ['  ConnectTimeout 10', '  ServerAliveInterval 15', '  ServerAliveCountMax 3']

/** Seti's rendering of hosts with their users and keys, then a catch-all for proxy and host keys. */
export function sandboxSshConfig(hosts: readonly RenderHost[], paths: SandboxSshPaths): string {
  const proxy =
    paths.proxy === null
      ? []
      : [`  ProxyCommand ${paths.proxy.socat} - PROXY:127.0.0.1:%h:%p,proxyport=${String(paths.proxy.port)}`]
  const catchAll = [
    'Host *',
    ...proxy,
    `  UserKnownHostsFile ${paths.knownHosts}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  UpdateHostKeys no',
    '  BatchMode yes',
    '  IdentitiesOnly yes',
    '  ForwardAgent no',
    '  ControlMaster no',
    ...DEAD_LINK_LIMITS,
  ]
  const blocks = [...(paths.first ?? []), ...hosts.flatMap((host) => [...renderHost(host), ''])]
  return `${[...blocks, ...catchAll].join('\n')}\n`
}

import { AWS_ACCESS_ID, DEFAULT_PROFILE_ID, type AccessChoice, type Task } from '@seti/shared'
import { effectiveAccess } from './agent-access.js'
import { mcpCatalog } from './mcp-selection.js'
import { accessDefaults } from './store/access.js'
import { setiPlugins } from './store/plugins.js'
import { sshHostStore } from './store/ssh.js'

/**
 * What an agent at Seti control Full may hand on to the agents it starts or imports: at most
 * what it reaches itself, always sandboxed and at Seti control Self.
 */
export interface AccessCap {
  /** The agent the cap comes from, named in what it holds back. */
  title: string
  profile_id: string
  ssh: ReadonlySet<string>
  aws: boolean
  mcp: ReadonlySet<string>
  plugins: ReadonlySet<string>
}

export async function capOf(caller: Task): Promise<AccessCap> {
  const view = await effectiveAccess(caller)
  const on = (kind: string) => new Set(view.items.filter((i) => i.kind === kind && i.enabled).map((i) => i.id))
  return {
    title: caller.title,
    profile_id: caller.profile_id,
    ssh: on('ssh'),
    aws: on('aws').size > 0,
    mcp: on('mcp'),
    plugins: on('plugin'),
  }
}

/** Overrides and opt-outs that keep a new agent inside the cap, against today's defaults. */
export interface CappedStart {
  access: AccessChoice[]
  mcp_disabled: string[]
  disabled_plugin_ids: string[]
  /** What the defaults would have given beyond the cap, for the agent's setup note. */
  held: string[]
}

export async function capStart(cap: AccessCap): Promise<CappedStart> {
  const [hosts, sshDefaults, awsDefaults, servers, plugins] = await Promise.all([
    sshHostStore.list(),
    accessDefaults.all('ssh'),
    accessDefaults.all('aws'),
    mcpCatalog(false),
    setiPlugins.list(),
  ])
  const ssh = hosts.filter((host) => sshDefaults[host.alias] === true && !cap.ssh.has(host.alias))
  const aws = awsDefaults[AWS_ACCESS_ID] === true && !cap.aws
  const mcp = servers.filter((server) => !cap.mcp.has(server.name)).map((server) => server.name)
  const pluginsOff = plugins.filter((plugin) => plugin.enabled && !cap.plugins.has(plugin.id))
  return {
    access: [
      ...ssh.map((host): AccessChoice => ({ kind: 'ssh', id: host.alias, enabled: false })),
      ...(aws ? [{ kind: 'aws', id: AWS_ACCESS_ID, enabled: false } satisfies AccessChoice] : []),
    ],
    mcp_disabled: mcp,
    disabled_plugin_ids: pluginsOff.map((plugin) => plugin.id),
    held: [
      ...ssh.map((host) => `SSH ${host.alias}`),
      ...(aws ? ['AWS'] : []),
      ...servers.filter((s) => s.default_enabled && !cap.mcp.has(s.name)).map((s) => `MCP ${s.name}`),
      ...pluginsOff.map((plugin) => `plugin ${plugin.name}`),
    ].map((item) => `${item}: beyond what ${cap.title} has`),
  }
}

/** What an agent on today's default access would reach beyond the cap; empty when it stays inside. */
export async function defaultsBeyond(cap: AccessCap): Promise<string[]> {
  const [sshDefaults, awsDefaults, servers, plugins] = await Promise.all([
    accessDefaults.all('ssh'),
    accessDefaults.all('aws'),
    mcpCatalog(false),
    setiPlugins.list(),
  ])
  return [
    ...(cap.profile_id === DEFAULT_PROFILE_ID ? [] : ['the default credentials']),
    ...Object.entries(sshDefaults).flatMap(([alias, on]) => (on && !cap.ssh.has(alias) ? [`SSH ${alias}`] : [])),
    ...(awsDefaults[AWS_ACCESS_ID] === true && !cap.aws ? ['AWS'] : []),
    ...servers.flatMap((s) => (s.default_enabled && !cap.mcp.has(s.name) ? [`MCP ${s.name}`] : [])),
    ...plugins.flatMap((p) => (p.enabled && !cap.plugins.has(p.id) ? [`plugin ${p.name}`] : [])),
  ]
}

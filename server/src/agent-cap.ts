import { AWS_ACCESS_ID, DEFAULT_PROFILE_ID, type AccessChoice, type Task } from '@seti/shared'
import { effectiveAccess } from './agent-access.js'
import { ceilingNote, ceilingOf, type ApprovalCeiling } from './approval-ceiling.js'
import { mcpCatalog } from './mcp-selection.js'
import { accessDefaults } from './store/access.js'
import { credentialAccess } from './store/credential-access.js'
import { setiPlugins } from './store/plugins.js'
import { sshHostStore } from './store/ssh.js'

/**
 * What an agent at Seti control Full may hand on to the agents it starts or imports: at most
 * what it reaches itself, always sandboxed and at Seti control Self, and approvals no looser.
 */
export interface AccessCap {
  /** The agent the cap comes from, named in what it holds back. */
  title: string
  profile_id: string
  ssh: ReadonlySet<string>
  aws: boolean
  mcp: ReadonlySet<string>
  plugins: ReadonlySet<string>
  /** The approval ceiling its agents get, so none settles calls more loosely than it does. */
  approvals: ApprovalCeiling | null
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
    approvals: await ceilingOf(caller),
  }
}

/** Overrides and opt-outs that keep a new agent inside the cap, whatever its base later says. */
export interface CappedStart {
  access: AccessChoice[]
  mcp_disabled: string[]
  disabled_plugin_ids: string[]
  /** What the cap held back from what the agent would get without it, for its setup note. */
  held: string[]
}

/** What a new agent on the credential gets without a choice: its set, else the default. */
async function baseOn(profileId: string) {
  const [ssh, aws, mcp, plugin, sshDefaults, awsDefaults] = await Promise.all([
    credentialAccess.of(profileId, 'ssh'),
    credentialAccess.of(profileId, 'aws'),
    credentialAccess.of(profileId, 'mcp'),
    credentialAccess.of(profileId, 'plugin'),
    accessDefaults.all('ssh'),
    accessDefaults.all('aws'),
  ])
  return {
    ssh: (alias: string) => ssh[alias] ?? sshDefaults[alias] ?? false,
    aws: aws[AWS_ACCESS_ID] ?? awsDefaults[AWS_ACCESS_ID] ?? false,
    mcp: (name: string, byDefault: boolean) => mcp[name] ?? byDefault,
    plugin: (id: string, byDefault: boolean) => plugin[id] ?? byDefault,
  }
}

/** Every item outside the cap is turned off as the new agent's own choice, so the cap lasts. */
export async function capStart(cap: AccessCap): Promise<CappedStart> {
  const [hosts, base, servers, plugins] = await Promise.all([
    sshHostStore.list(),
    baseOn(cap.profile_id),
    mcpCatalog(false),
    setiPlugins.list(),
  ])
  const ssh = hosts.filter((host) => !cap.ssh.has(host.alias))
  const mcp = servers.filter((server) => !cap.mcp.has(server.name))
  const pluginsOff = plugins.filter((plugin) => !cap.plugins.has(plugin.id))
  return {
    access: [
      ...ssh.map((host): AccessChoice => ({ kind: 'ssh', id: host.alias, enabled: false })),
      ...(cap.aws ? [] : [{ kind: 'aws', id: AWS_ACCESS_ID, enabled: false } satisfies AccessChoice]),
    ],
    mcp_disabled: mcp.map((server) => server.name),
    disabled_plugin_ids: pluginsOff.map((plugin) => plugin.id),
    held: [
      ...[
        ...ssh.filter((host) => base.ssh(host.alias)).map((host) => `SSH ${host.alias}`),
        ...(!cap.aws && base.aws ? ['AWS'] : []),
        ...mcp.filter((s) => base.mcp(s.name, s.default_enabled)).map((s) => `MCP ${s.name}`),
        ...pluginsOff.filter((p) => base.plugin(p.id, p.enabled)).map((plugin) => `plugin ${plugin.name}`),
      ].map((item) => `${item}: beyond what ${cap.title} has`),
      ...(cap.approvals === null ? [] : [ceilingNote(cap.title)]),
    ],
  }
}

/** What an agent on the default credential's access would reach beyond the cap; empty when inside. */
export async function defaultsBeyond(cap: AccessCap): Promise<string[]> {
  const [hosts, base, servers, plugins] = await Promise.all([
    sshHostStore.list(),
    baseOn(DEFAULT_PROFILE_ID),
    mcpCatalog(false),
    setiPlugins.list(),
  ])
  return [
    ...(cap.profile_id === DEFAULT_PROFILE_ID ? [] : ['the default credentials']),
    ...hosts.flatMap(({ alias }) => (base.ssh(alias) && !cap.ssh.has(alias) ? [`SSH ${alias}`] : [])),
    ...(base.aws && !cap.aws ? ['AWS'] : []),
    ...servers.flatMap((s) => (base.mcp(s.name, s.default_enabled) && !cap.mcp.has(s.name) ? [`MCP ${s.name}`] : [])),
    ...plugins.flatMap((p) => (base.plugin(p.id, p.enabled) && !cap.plugins.has(p.id) ? [`plugin ${p.name}`] : [])),
    ...(cap.approvals === null ? [] : ["Claude Code's classifier, which decides calls a Codex agent asks about"]),
  ]
}

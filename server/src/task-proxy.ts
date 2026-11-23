import path from 'node:path'
import { AWS_SETTINGS_DEFAULT, DEFAULT_PROFILE_ID, type AwsSettings, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { awsBroker } from './aws-credentials.js'
import { claudeCredential, connectorCredential } from './claude-credential.js'
import { hostLoginKey } from './claude-logins.js'
import { SETI_HOME } from './config.js'
import { connectionPlaceholders, connectionRules, taskConnections } from './connection-egress.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import { ruleCaHosts, type EgressRule } from './egress-rules.js'
import { agentToken, tokenOwner } from './github-token.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import { nodeLink } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'
import { awsToken, forgetAwsToken } from './sandbox-aws-token.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'
import { mcpHosts } from './sandbox-mcp.js'
import { allowedFor } from './store/change-requests.js'
import { profiles } from './store/credentials.js'
import { mcpLoginRules } from './task-credentials.js'

const CA_DIR = path.join(SETI_HOME, 'sandbox-ca')

let ca: Promise<SandboxCa> | null = null

/** The CAs that sign the hosts agents' proxies intercept, loaded once. */
export async function sandboxCa(): Promise<SandboxCa> {
  ca ??= loadSandboxCa(CA_DIR).catch((e: unknown) => {
    ca = null
    throw e
  })
  return ca
}

const proxies = new Map<string, Promise<EgressProxy>>()

/** What a task's session started with: its credential, connection headers, MCP choices and login. */
interface SessionAccess {
  profileId: string
  rules: readonly EgressRule[]
  placeholders: readonly EgressPlaceholder[]
  deniedConnectors: ReadonlySet<string>
  login: string | null
}

const access = new Map<string, SessionAccess>()
const NO_ACCESS: SessionAccess = {
  profileId: DEFAULT_PROFILE_ID,
  rules: [],
  placeholders: [],
  deniedConnectors: new Set(),
  login: null,
}
const accessOf = (taskId: string) => access.get(taskId) ?? NO_ACCESS

export async function profileAws(profileId: string): Promise<AwsSettings> {
  return (await profiles.get(profileId))?.aws ?? AWS_SETTINGS_DEFAULT
}

async function taskProxy(task: Task, authority: SandboxCa): Promise<EgressProxy> {
  const taskId = task.id
  const existing = proxies.get(taskId)
  if (existing !== undefined) {
    return existing
  }
  const refused = new Set<string>()
  const started = startEgressProxy({
    socketPath: path.join(sandboxDirOf(taskId), 'run', 'proxy.sock'),
    allowed: async () => allowedFor(taskId),
    ca: authority,
    credentials: {
      claude: async () => (await claudeCredential(accessOf(taskId).login))?.token ?? null,
      github: async (owner) => agentToken(accessOf(taskId).profileId, owner ?? tokenOwner(task)),
      connector: async () => Promise.resolve(connectorCredential()),
    },
    rules: () => accessOf(taskId).rules,
    placeholders: () => accessOf(taskId).placeholders,
    onBlocked: (host, names) => {
      void nodeLink.journal(taskId, { type: 'egress.blocked', host, names: [...names] }).catch(() => undefined)
    },
    connectorAllowed: (id) => !accessOf(taskId).deniedConnectors.has(id),
    ssh: async (target) => (await taskSsh(taskId)).firstHops.includes(target),
    aws: {
      enabled: async () => taskAws(taskId),
      token: awsToken(taskId),
      credentials: async () => awsBroker.credentials(await profileAws(accessOf(taskId).profileId)),
    },
    onRefused: (host) => {
      if (!refused.has(host)) {
        refused.add(host)
        process.stderr.write(`sandbox: task ${taskId} was refused ${host}\n`)
      }
    },
  })
  proxies.set(taskId, started)
  started.catch(() => proxies.delete(taskId))
  return started
}

/** What the task's sandbox and proxy take from its connections and MCP choices. */
export async function grantAccess(task: Task) {
  const denied = new Set(await taskDeniedServers(task.id))
  const connections = await taskConnections(task)
  const headerRules = connectionRules(connections)
  const rules = [...headerRules, ...mcpLoginRules(denied)]
  access.set(task.id, {
    profileId: task.profile_id,
    rules,
    placeholders: connectionPlaceholders(connections),
    deniedConnectors: new Set(connectorIds([...denied])),
    login: hostLoginKey(),
  })
  return { denied, connections, headerRules, rules }
}

/** Starts the task's proxy, its CA first covering every host the proxy intercepts. */
export async function startProxy(task: Task, intercepted: readonly string[]): Promise<void> {
  const authority = await sandboxCa()
  await authority.cover([...mcpHosts(), ...intercepted])
  await taskProxy(task, authority)
}

/** Opens the task's proxy for a sandbox another process builds; a running one stays as it is. */
export async function openTaskProxy(task: Task): Promise<void> {
  if (!proxies.has(task.id)) {
    const { rules, connections } = await grantAccess(task)
    await startProxy(task, ruleCaHosts([...rules, ...connections]))
  }
}

/** Stops a deleted task's proxy and forgets what it held. */
export async function closeTaskProxy(taskId: string): Promise<void> {
  const proxy = proxies.get(taskId)
  proxies.delete(taskId)
  forgetAwsToken(taskId)
  access.delete(taskId)
  await proxy?.then(async (running) => running.close()).catch(() => undefined)
}

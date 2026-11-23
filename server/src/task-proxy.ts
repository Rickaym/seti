import path from 'node:path'
import type { NodeAsk, ProxyGrant } from '@seti/shared'
import { askInTime } from './ask-in-time.js'
import { SETI_HOME } from './config.js'
import { connectionPlaceholders, connectionRules, mcpLoginRules, type ConnectionValue } from './egress-connections.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import type { EgressRule } from './egress-rules.js'
import { nodeLink } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'
import { proxyCa } from './proxy-owner.js'
import { awsToken, forgetAwsToken } from './sandbox-aws-token.js'
import { loadSandboxCa, sandboxCaFiles, type SandboxCa } from './sandbox-ca.js'
import { sshAgentSocket, stopSshAgent } from './ssh-agent.js'

const CA_DIR = path.join(SETI_HOME, 'sandbox-ca')

let ca: Promise<SandboxCa> | null = null

/** The CAs that sign the hosts agents' proxies intercept, loaded once. */
async function sandboxCa(): Promise<SandboxCa> {
  ca ??= loadSandboxCa(CA_DIR).catch((e: unknown) => {
    ca = null
    throw e
  })
  return ca
}

/** The CA files a sandbox mounts; only the process that runs proxies loads and writes them. */
export const sandboxCaPublic = async () => proxyCa(sandboxCa, () => sandboxCaFiles(CA_DIR))

const proxies = new Map<string, Promise<EgressProxy>>()

/** What a task's session started with: its connection headers, MCP choices and login. */
interface SessionAccess {
  rules: readonly EgressRule[]
  placeholders: readonly EgressPlaceholder[]
  deniedConnectors: ReadonlySet<string>
  login: string | null
}

const access = new Map<string, SessionAccess>()
const NO_ACCESS: SessionAccess = { rules: [], placeholders: [], deniedConnectors: new Set(), login: null }
const accessOf = (taskId: string) => access.get(taskId) ?? NO_ACCESS

/** A credential the control plane hands the proxy for one request; the node keeps none. */
const mint = async (taskId: string, ask: NodeAsk<'secret.mint'>) => (await askInTime(taskId, 'secret.mint', ask)).token

/** A connection's value, asked for each request, so a changed or removed one applies at once. */
export const connectionValueAsk =
  (taskId: string): ConnectionValue =>
  async (connection, refused) =>
    (await askInTime(taskId, 'connection.value', { connection: connection.id, refused })).value

/** Where the agent may open ssh to and whether it gets AWS credentials, asked when it matters. */
const reach = async (taskId: string) => askInTime(taskId, 'access.reach', {})

/** Starts the agent's ssh agent, which asks for the keys of its usable hosts on every load. */
export async function openTaskSsh(taskId: string): Promise<void> {
  await sshAgentSocket(taskId, path.join(sandboxDirOf(taskId), 'ssh-agent'), async () => {
    return (await askInTime(taskId, 'ssh.keys', {})).keys
  })
}

async function taskProxy(taskId: string, authority: SandboxCa): Promise<EgressProxy> {
  const existing = proxies.get(taskId)
  if (existing !== undefined) {
    return existing
  }
  const refused = new Set<string>()
  const started = startEgressProxy({
    socketPath: path.join(sandboxDirOf(taskId), 'run', 'proxy.sock'),
    allowed: async () => (await askInTime(taskId, 'sandbox.hosts', {})).hosts,
    ca: authority,
    credentials: {
      claude: async () => mint(taskId, { kind: 'claude', login: accessOf(taskId).login }),
      github: async (owner) => mint(taskId, { kind: 'github', owner }),
      connector: async () => mint(taskId, { kind: 'connector' }),
    },
    rules: () => accessOf(taskId).rules,
    placeholders: () => accessOf(taskId).placeholders,
    onBlocked: (host, names) => {
      void nodeLink.journal(taskId, { type: 'egress.blocked', host, names: [...names] }).catch(() => undefined)
    },
    connectorAllowed: (id) => !accessOf(taskId).deniedConnectors.has(id),
    ssh: async (target) => (await reach(taskId)).sshHops.includes(target),
    aws: {
      enabled: async () => (await reach(taskId)).aws,
      token: awsToken(taskId),
      credentials: async () => (await askInTime(taskId, 'aws.credentials', {})).credentials,
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

/** Hands the agent's proxy what it applies from now on. */
function applyGrant(taskId: string, grant: ProxyGrant): void {
  const value = connectionValueAsk(taskId)
  const mcp = async (url: URL) => mint(taskId, { kind: 'mcp', url: url.href })
  access.set(taskId, {
    rules: [...connectionRules(grant.connections, value), ...mcpLoginRules(grant.mcp, mcp)],
    placeholders: connectionPlaceholders(grant.connections, value),
    deniedConnectors: new Set(grant.deniedConnectors),
    login: grant.login,
  })
}

/** Starts the task's proxy with this grant, its CA first covering every host the proxy intercepts. */
export async function startProxy(taskId: string, grant: ProxyGrant): Promise<void> {
  applyGrant(taskId, grant)
  const authority = await sandboxCa()
  await authority.cover(grant.caHosts)
  await taskProxy(taskId, authority)
}

/** Opens the task's proxy for a sandbox another process builds; a running one stays as it is. */
export async function openTaskProxy(taskId: string, grant: ProxyGrant): Promise<void> {
  if (!proxies.has(taskId)) {
    await startProxy(taskId, grant)
  }
}

/** Stops a deleted task's proxy and ssh agent and forgets what they held. */
export async function closeTaskProxy(taskId: string): Promise<void> {
  const proxy = proxies.get(taskId)
  proxies.delete(taskId)
  forgetAwsToken(taskId)
  access.delete(taskId)
  await proxy?.then(async (running) => running.close()).catch(() => undefined)
  await stopSshAgent(taskId)
}

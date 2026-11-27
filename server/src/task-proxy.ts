import fs from 'node:fs'
import path from 'node:path'
import type { GrantConnection, ModelReach, NodeAsk, ProxyGrant } from '@seti/shared'
import { askInTime } from './ask-in-time.js'
import { SETI_HOME } from './config.js'
import {
  connectionEnv,
  connectionPlaceholders,
  connectionRules,
  mcpLoginRules,
  type ConnectionValue,
} from './egress-connections.js'
import { modelOnly } from './egress-hosts.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy, type Upstream } from './egress-proxy.js'
import { refusalReporter } from './egress-refusals.js'
import { ruleCaHosts, type EgressRule } from './egress-rules.js'
import { nodeLink } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'
import { proxyCa } from './proxy-owner.js'
import { awsToken, forgetAwsToken } from './sandbox-aws-token.js'
import { loadSandboxCa, sandboxCaFiles, type SandboxCa } from './sandbox-ca.js'
import { writeSandboxEnv } from './sandbox-env-file.js'
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

/** Where proxies started from now on send their traffic, which only tests set; see below. */
interface TestEgress {
  upstream: Upstream
  refused: (host: string) => void
}

let testEgress: TestEgress | null = null

/**
 * For tests only: proxies started from now on reach their hosts through `egress.upstream` and
 * report each host they refuse. No setting, variable or route reaches this; a test proves that
 * only test files call it.
 */
export function routeEgressForTests(egress: TestEgress | null): void {
  testEgress = egress
}

/** What a task's session started with: its connection headers, MCP choices and login. */
interface SessionAccess {
  rules: readonly EgressRule[]
  placeholders: readonly EgressPlaceholder[]
  modelHosts: readonly string[]
  deniedConnectors: ReadonlySet<string>
  login: string | null
  anthropic: boolean
}

const access = new Map<string, SessionAccess>()
/** The grant each running proxy applies, which a change of connections updates in place. */
const grants = new Map<string, ProxyGrant>()
const NO_ACCESS: SessionAccess = {
  rules: [],
  placeholders: [],
  modelHosts: [],
  deniedConnectors: new Set(),
  login: null,
  anthropic: true,
}
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

/** An Anthropic credential, only for an agent whose runtime talks to Anthropic; else none is sent. */
async function anthropic(taskId: string, ask: NodeAsk<'secret.mint'>): Promise<string | null> {
  return accessOf(taskId).anthropic ? mint(taskId, ask) : null
}

/** Reports a request the proxy refused for carrying placeholders, which the control plane audits. */
const journalBlocked = (taskId: string) => (host: string, names: readonly string[]) => {
  void nodeLink.journal(taskId, { type: 'egress.blocked', host, names: [...names] }).catch(() => undefined)
}

async function taskProxy(taskId: string, authority: SandboxCa): Promise<EgressProxy> {
  const existing = proxies.get(taskId)
  if (existing !== undefined) {
    return existing
  }
  const reportRefused = refusalReporter((host, count) => {
    void nodeLink.journal(taskId, { type: 'egress.refused', host, count }).catch(() => undefined)
  })
  const started = startEgressProxy({
    socketPath: path.join(sandboxDirOf(taskId), 'run', 'proxy.sock'),
    allowed: async () => (await askInTime(taskId, 'sandbox.hosts', {})).hosts,
    ca: authority,
    credentials: {
      claude: async () => anthropic(taskId, { kind: 'claude', login: accessOf(taskId).login }),
      github: async (owner) => mint(taskId, { kind: 'github', owner }),
      connector: async () => anthropic(taskId, { kind: 'connector' }),
    },
    rules: () => accessOf(taskId).rules,
    placeholders: () => accessOf(taskId).placeholders,
    modelHosts: () => accessOf(taskId).modelHosts,
    onBlocked: journalBlocked(taskId),
    connectorAllowed: (id) => !accessOf(taskId).deniedConnectors.has(id),
    ssh: async (target) => (await reach(taskId)).sshHops.includes(target),
    aws: {
      enabled: async () => (await reach(taskId)).aws,
      token: awsToken(taskId),
      credentials: async () => (await askInTime(taskId, 'aws.credentials', {})).credentials,
    },
    ...(testEgress === null ? {} : { upstream: testEgress.upstream }),
    onRefused: (host) => {
      testEgress?.refused(host)
      reportRefused(host)
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
  grants.set(taskId, grant)
  access.set(taskId, {
    rules: [...connectionRules(grant.connections, value), ...mcpLoginRules(grant.mcp, mcp)],
    placeholders: connectionPlaceholders(grant.connections, value),
    modelHosts: grant.modelHosts,
    deniedConnectors: new Set(grant.deniedConnectors),
    login: grant.login,
    anthropic: grant.anthropic,
  })
}

/** Starts the task's proxy with this grant, its CA first covering every host the proxy intercepts. */
export async function startProxy(taskId: string, grant: ProxyGrant): Promise<void> {
  applyGrant(taskId, grant)
  const authority = await sandboxCa()
  await authority.cover(grant.caHosts)
  await taskProxy(taskId, authority)
}

/**
 * Gives the agent's running proxy its credential's connections as they are now, keeping the rest
 * of its grant, and writes their placeholders to the env file its sandbox's shells read. False
 * when no proxy runs for the agent, so its next sandbox takes them when it starts.
 */
export async function regrantConnections(taskId: string, connections: readonly GrantConnection[]): Promise<boolean> {
  const current = grants.get(taskId)
  if (current === undefined || !proxies.has(taskId)) {
    return false
  }
  const caHosts = [...new Set([...current.caHosts, ...ruleCaHosts(connections)])]
  await (await sandboxCa()).cover(caHosts)
  applyGrant(taskId, { ...current, connections: [...connections], caHosts })
  return writeSandboxEnv(path.join(sandboxDirOf(taskId), 'run'), connectionEnv(connections))
}

/** Opens the task's proxy for a sandbox another process builds; a running one stays as it is. */
export async function openTaskProxy(taskId: string, grant: ProxyGrant): Promise<void> {
  if (!proxies.has(taskId)) {
    await startProxy(taskId, grant)
  }
}

/** Where a maintenance sandbox of the agent keeps its own home, /tmp and proxy socket. */
export const maintenanceDirOf = (taskId: string) => path.join(sandboxDirOf(taskId), 'maintenance')

const modelProxies = new Map<string, Promise<EgressProxy>>()
const modelReaches = new Map<string, ModelReach>()

/** The key connection of a model reach as the proxy applies it, its value asked for each request. */
function keyRules(taskId: string) {
  const key = modelReaches.get(taskId)?.key ?? null
  const value = connectionValueAsk(taskId)
  return key === null
    ? { rules: [], placeholders: [] }
    : { rules: connectionRules([key], value), placeholders: connectionPlaceholders([key], value) }
}

/**
 * Opens the proxy of the agent's maintenance sandbox, which reaches the model provider with the
 * agent's login, or the connection of its OpenAI key, and nothing else: no allowlist, other
 * connection, connector, cloud or ssh. A proxy already open applies the new reach at once.
 */
export async function openModelProxy(taskId: string, model: ModelReach): Promise<void> {
  modelReaches.set(taskId, model)
  const authority = await sandboxCa()
  await authority.cover(model.key === null ? [] : ruleCaHosts([model.key]))
  if (modelProxies.has(taskId)) {
    return
  }
  const run = path.join(maintenanceDirOf(taskId), 'run')
  fs.mkdirSync(run, { recursive: true, mode: 0o700 })
  const started = startEgressProxy({
    socketPath: path.join(run, 'proxy.sock'),
    ca: authority,
    ...modelOnly(async () => mint(taskId, { kind: 'claude', login: modelReaches.get(taskId)?.login ?? null })),
    rules: () => keyRules(taskId).rules,
    placeholders: () => keyRules(taskId).placeholders,
    modelHosts: () => modelReaches.get(taskId)?.modelHosts ?? [],
    onBlocked: journalBlocked(taskId),
    ...(testEgress === null ? {} : { upstream: testEgress.upstream, onRefused: testEgress.refused }),
  })
  modelProxies.set(taskId, started)
  started.catch(() => modelProxies.delete(taskId))
  await started
}

/** Stops a deleted task's proxies and ssh agent and forgets what they held. */
export async function closeTaskProxy(taskId: string): Promise<void> {
  const running = [proxies.get(taskId), modelProxies.get(taskId)]
  proxies.delete(taskId)
  modelProxies.delete(taskId)
  modelReaches.delete(taskId)
  forgetAwsToken(taskId)
  access.delete(taskId)
  grants.delete(taskId)
  for (const proxy of running) {
    await proxy?.then(async (open) => open.close()).catch(() => undefined)
  }
  await stopSshAgent(taskId)
}

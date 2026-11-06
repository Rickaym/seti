import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AWS_CREDENTIALS_PATH,
  AWS_SETTINGS_DEFAULT,
  DEFAULT_PROFILE_ID,
  extraDirs,
  type AwsSettings,
  type MemoryCap,
  type SandboxPolicy,
  type Task,
} from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { awsBroker } from './aws-credentials.js'
import { findBinary } from './binaries.js'
import { claudeCredential, CONNECTOR_SCOPE, connectorCredential } from './claude-credential.js'
import { hostLoginKey } from './claude-logins.js'
import { CLAUDE_HOME, SETI_HOME, WORKTREE_ROOT } from './config.js'
import {
  auditBlockedKey,
  connectionEnv,
  connectionPlaceholders,
  connectionRules,
  taskConnections,
} from './connection-egress.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import { ruleCaHosts, ruleCovers, type EgressRule } from './egress-rules.js'
import { agentToken, agentTokenStamp } from './github-token.js'
import { taskBorrowedServers } from './mcp-borrowed.js'
import { connectorIds, taskDeniedServers } from './mcp-selection.js'
import { launch, type ScopePlan } from './memory-scope.js'
import { memoryEnv } from './node-heap.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'
import { sandboxClaudeJson } from './sandbox-claude-json.js'
import { gitEnv } from './sandbox-git.js'
import {
  forgetSandboxSignIns,
  hostClaudeJson,
  mcpHosts,
  mcpTokens,
  proxiedServers,
  signedInServers,
} from './sandbox-mcp.js'
import {
  bwrapArgs,
  canonicalRoot,
  mountProblem,
  SANDBOX_CA,
  SANDBOX_RUN,
  SANDBOX_SSH_AGENT,
  sandboxMounts,
  type SandboxLayout,
} from './sandbox-mounts.js'
import { homeExcluded, type SandboxContext, sandboxHiddenPaths } from './sandbox.js'
import { SSH_AGENT_SOCKET, stopSshAgent } from './ssh-agent.js'
import { hostKeys, prepareSandboxSsh } from './ssh-files.js'
import { allowedFor } from './store/change-requests.js'
import { profiles } from './store/credentials.js'
import { mcpLoginRules } from './task-credentials.js'
import { toolShellEnv, writeToolShell } from './tool-shell.js'
import { workspaceDir } from './workspace/dir.js'

/** The loopback port inside a sandbox where socat hands connections to the task's proxy socket. */
const PROXY_PORT = 3128
const PROXY_URL = `http://127.0.0.1:${String(PROXY_PORT)}`

/** What sandboxed processes hold instead of credentials; the proxy swaps in the real ones. */
export const CLAUDE_PLACEHOLDER = 'sk-ant-oat01-seti-sandbox-placeholder'
export const GITHUB_PLACEHOLDER = 'seti-sandbox-placeholder'

const SANDBOX_ROOT = path.join(SETI_HOME, 'sandbox')
const CA_DIR = path.join(SETI_HOME, 'sandbox-ca')

/** Variables a sandbox inherits from the server; the rest, secrets among them, stay outside. */
const PASSED_ENV = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'PNPM_HOME',
  'RUSTUP_HOME',
  'GOROOT',
  'JAVA_HOME',
]

const portHex = PROXY_PORT.toString(16).toUpperCase().padStart(4, '0')

/**
 * Bridges the in-sandbox proxy port to the task's socket, waits until it listens, then runs the
 * command. socat dies with the command, else bwrap's init would wait for it and keep the sandbox.
 */
const initScript = (setpriv: string, socat: string) =>
  [
    `${setpriv} --pdeathsig KILL ${socat} TCP-LISTEN:${String(PROXY_PORT)},bind=127.0.0.1,fork,reuseaddr ` +
      `UNIX-CONNECT:${SANDBOX_RUN}/proxy.sock 2>/dev/null &`,
    'i=0',
    `while [ $i -lt 500 ] && ! grep -q ' 0100007F:${portHex} 00000000:0000 0A' /proc/net/tcp; do`,
    '  sleep 0.01; i=$((i+1))',
    'done',
    'exec "$@"',
  ].join('\n')

export interface SandboxEnvOptions {
  github: boolean
  /** The host login may reach claude.ai connectors, so Claude Code inside should load them. */
  connectors: boolean
  /** The task's AWS credentials endpoint token and region, when it has AWS on. */
  aws?: { token: string; region: string } | null
  /** The task has ssh hosts, so ssh inside talks to Seti's agent. */
  ssh?: boolean
  /** The memory cap that holds the agent's process tree, when the host enforces one. */
  memory?: MemoryCap | null
  /** Connection variables and the placeholders they hold, which the proxy swaps on their hosts. */
  connections?: Readonly<Record<string, string>>
}

/** Where the sandbox sees the prefix its tools start through, in its read-only run directory. */
const SANDBOX_TOOL_SHELL = `${SANDBOX_RUN}/tool-shell`

/** AWS tools inside fetch the set's role's credentials from the proxy, never from EC2. */
function awsEnv(aws: SandboxEnvOptions['aws']): Record<string, string> {
  if (aws === undefined || aws === null) {
    return {}
  }
  return {
    AWS_CONTAINER_CREDENTIALS_FULL_URI: `${PROXY_URL}${AWS_CREDENTIALS_PATH}`,
    AWS_CONTAINER_AUTHORIZATION_TOKEN: aws.token,
    AWS_REGION: aws.region,
    AWS_DEFAULT_REGION: aws.region,
    AWS_EC2_METADATA_DISABLED: 'true',
  }
}

/** The environment every process of a sandbox starts with. */
export function sandboxEnv(
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  options: SandboxEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (PASSED_ENV.includes(key) || key.startsWith('LC_'))) {
      env[key] = value
    }
  }
  const user = os.userInfo().username
  const bundle = `${SANDBOX_CA}/bundle.pem`
  return {
    ...env,
    ...options.connections,
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: '/bin/bash',
    TMPDIR: '/tmp',
    SETI_SANDBOX: '1',
    ANTHROPIC_BASE_URL: PROXY_URL,
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_PLACEHOLDER,
    ...(options.connectors ? { CLAUDE_CODE_OAUTH_SCOPES: `user:inference ${CONNECTOR_SCOPE}` } : {}),
    HTTPS_PROXY: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    https_proxy: PROXY_URL,
    http_proxy: PROXY_URL,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    NODE_USE_ENV_PROXY: '1',
    ...memoryEnv(undefined, options.memory ?? null),
    ...(options.memory === undefined || options.memory === null ? {} : toolShellEnv(SANDBOX_TOOL_SHELL)),
    NODE_EXTRA_CA_CERTS: `${SANDBOX_CA}/ca.pem`,
    SSL_CERT_FILE: bundle,
    GIT_SSL_CAINFO: bundle,
    CURL_CA_BUNDLE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    GH_PROMPT_DISABLED: '1',
    ...(options.github ? { GH_TOKEN: GITHUB_PLACEHOLDER } : {}),
    ...awsEnv(options.aws),
    ...(options.ssh === true ? { SSH_AUTH_SOCK: `${SANDBOX_SSH_AGENT}/${SSH_AGENT_SOCKET}` } : {}),
    ...gitEnv(),
  }
}

let ca: Promise<SandboxCa> | null = null

async function sandboxCa(): Promise<SandboxCa> {
  ca ??= loadSandboxCa(CA_DIR).catch((e: unknown) => {
    ca = null
    throw e
  })
  return ca
}

const proxies = new Map<string, Promise<EgressProxy>>()
const awsTokens = new Map<string, string>()

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

async function profileAws(profileId: string): Promise<AwsSettings> {
  return (await profiles.get(profileId))?.aws ?? AWS_SETTINGS_DEFAULT
}

/** The task's AWS container authorization token, the same for its proxy and its processes. */
function awsToken(taskId: string): string {
  let token = awsTokens.get(taskId)
  if (token === undefined) {
    token = randomBytes(24).toString('base64url')
    awsTokens.set(taskId, token)
  }
  return token
}

const taskDir = (taskId: string) => path.join(SANDBOX_ROOT, taskId)

/** The host directory a task's sandbox sees as /tmp. */
export const sandboxTmpDir = (taskId: string) => path.join(taskDir(taskId), 'tmp')

/** The owner of the task's first repo, whose GitHub token covers requests that name no owner. */
const taskOwner = (task: Task) => task.repos[0]?.slug.split('/')[0] ?? null

async function taskProxy(task: Task, authority: SandboxCa): Promise<EgressProxy> {
  const taskId = task.id
  const existing = proxies.get(taskId)
  if (existing !== undefined) {
    return existing
  }
  const refused = new Set<string>()
  const started = startEgressProxy({
    socketPath: path.join(taskDir(taskId), 'run', 'proxy.sock'),
    allowed: async () => allowedFor(taskId),
    ca: authority,
    credentials: {
      claude: async () => (await claudeCredential(accessOf(taskId).login))?.token ?? null,
      github: async (owner) => agentToken(accessOf(taskId).profileId, owner ?? taskOwner(task)),
      connector: async () => Promise.resolve(connectorCredential()),
    },
    rules: () => accessOf(taskId).rules,
    placeholders: () => accessOf(taskId).placeholders,
    onBlocked: (host, names) => {
      void auditBlockedKey(task, host, names)
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

/** Stops a deleted task's proxy and removes its sandbox state. */
export async function removeTaskSandbox(taskId: string): Promise<void> {
  const proxy = proxies.get(taskId)
  proxies.delete(taskId)
  awsTokens.delete(taskId)
  access.delete(taskId)
  await proxy?.then(async (running) => running.close()).catch(() => undefined)
  await stopSshAgent(taskId)
  fs.rmSync(taskDir(taskId), { recursive: true, force: true })
}

interface SpawnInSandbox {
  signal?: AbortSignal
  detached?: boolean
  env?: Readonly<Record<string, string | undefined>>
  stdin?: 'pipe' | 'ignore'
  /** Runs the sandbox in a systemd scope held to the task's memory cap. */
  scope?: ScopePlan | null
}

interface SandboxCommandOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Runs it through a systemd scope, so the sandbox never sees the user bus. */
  scope?: ScopePlan | null
  /** Keeps the caller's pseudo-terminal as the controlling terminal inside. */
  interactive?: boolean
}

/** The program, arguments and environment that run a command in the sandbox. */
interface SandboxCommand {
  program: string
  args: string[]
  env: Record<string, string | undefined>
}

export interface TaskSandbox {
  env: Record<string, string>
  spawn: (command: string, args: readonly string[], options?: SpawnInSandbox) => ChildProcess
  /** What `spawn` runs, for a caller that starts the process itself, such as in a pseudo-terminal. */
  command: (command: string, args: readonly string[], options?: SandboxCommandOptions) => SandboxCommand
}

export interface SandboxRequest {
  ctx: SandboxContext
  policy: SandboxPolicy
  /** Read-only extras, such as local plugin folders. */
  readOnly?: readonly string[]
  /** The memory cap that holds the task's process trees, when the host enforces one. */
  memory?: MemoryCap | null
}

/** The task's ssh files and agent for its usable hosts; none, and no agent, without any. */
async function sandboxSsh(taskId: string, dir: string, home: string, socat: string) {
  const reach = await taskSsh(taskId)
  if (reach.usable.length === 0) {
    await stopSshAgent(taskId)
    return null
  }
  const keys = async () => hostKeys((await taskSsh(taskId)).hosts)
  return prepareSandboxSsh({ taskId, taskDir: dir, home, proxy: { socat, port: PROXY_PORT }, reach, keys })
}

function prepareDirs(dir: string): void {
  for (const sub of ['home', 'tmp', 'run']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 })
  }
  fs.chmodSync(dir, 0o700)
  writeToolShell(path.join(dir, 'run', path.basename(SANDBOX_TOOL_SHELL)))
}

/**
 * Prepares a task's sandbox: its state directories, filtered Claude Code config and egress
 * proxy. Throws when a sandbox tool is missing or a task directory cannot be mounted.
 */
export async function taskSandbox(task: Task, request: SandboxRequest): Promise<TaskSandbox> {
  const bwrap = findBinary('bwrap')
  const socat = findBinary('socat')
  const setpriv = findBinary('setpriv')
  const envBinary = findBinary('env')
  const { ctx, policy } = request
  const dir = taskDir(task.id)
  const layout: SandboxLayout = {
    home: ctx.home,
    setiHome: SETI_HOME,
    worktreeRoot: WORKTREE_ROOT,
    claudeHome: CLAUDE_HOME,
    taskDir: dir,
    cwd: task.cwd,
    dirs: extraDirs(task),
    workspace: workspaceDir(task.id),
    readOnly: request.readOnly ?? [],
    caDir: '',
    systemBundle: null,
    hidden: sandboxHiddenPaths(policy, ctx),
    excluded: homeExcluded(ctx),
    pathEnv: process.env.PATH ?? '',
    sessionId: task.session_id,
  }
  for (const workDir of [layout.cwd, ...layout.dirs]) {
    const problem = mountProblem(workDir, layout)
    if (problem !== null) {
      throw new Error(`The sandbox cannot run this agent: ${problem}. Start it without the sandbox instead.`)
    }
  }
  prepareDirs(dir)
  fs.mkdirSync(workspaceDir(task.id), { recursive: true, mode: 0o700 })
  const projects = [task.cwd, canonicalRoot(task.cwd) ?? task.cwd]
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
  sandboxClaudeJson(hostClaudeJson(), path.join(dir, 'home', '.claude.json'), {
    signedIn: signedInServers(),
    projects: [...new Set(projects)],
    denied,
    covered: (host) => headerRules.some((rule) => ruleCovers(rule, host, 443)),
    borrowed: await taskBorrowedServers(task),
  })
  forgetSandboxSignIns(path.join(dir, 'home', '.claude'), proxiedServers(mcpTokens, denied))
  const authority = await sandboxCa()
  await authority.cover([...mcpHosts(), ...ruleCaHosts([...rules, ...connections])])
  await taskProxy(task, authority)
  const ssh = await sandboxSsh(task.id, dir, ctx.home, socat)
  const ready = { ...layout, caDir: authority.publicDir, systemBundle: authority.systemBundle, ssh }
  const env = sandboxEnv(process.env, ctx.home, {
    github: (await agentTokenStamp(task.profile_id)) !== null,
    connectors: connectorCredential() !== null,
    aws: (await taskAws(task.id))
      ? { token: awsToken(task.id), region: (await profileAws(task.profile_id)).region }
      : null,
    ssh: ssh !== null,
    memory: request.memory ?? null,
    connections: connectionEnv(connections),
  })
  const command = (program: string, args: readonly string[], options: SandboxCommandOptions = {}) => {
    const extra = path.isAbsolute(program) ? [program] : []
    const mounts = sandboxMounts({ ...ready, readOnly: [...ready.readOnly, ...extra] })
    const init = ['--', '/bin/sh', '-c', initScript(setpriv, socat), 'seti', program]
    const argv = [...bwrapArgs(mounts, task.cwd, options.interactive === true), ...init, ...args]
    const plan = options.scope ?? null
    const base = options.env ?? env
    if (plan === null) {
      return { program: bwrap, args: argv, env: { ...base } }
    }
    // systemd-run needs the user bus; the sandbox never sees where it is.
    return {
      program: envBinary,
      args: ['-u', 'XDG_RUNTIME_DIR', bwrap, ...argv],
      env: { ...base, XDG_RUNTIME_DIR: plan.host.runtimeDir },
    }
  }
  return {
    env,
    command,
    spawn: (program, args, options = {}) => {
      const run = command(program, args, options)
      return launch(options.scope ?? null, run.program, run.args, (file, fileArgs) =>
        spawn(file, fileArgs, {
          env: run.env,
          stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          detached: options.detached === true,
        }),
      )
    },
  }
}

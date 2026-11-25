import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AWS_CREDENTIALS_PATH, extraDirs, hostMatches, type MemoryCap, type Task } from '@seti/shared'
import { findBinary } from './binaries.js'
import { CONNECTOR_SCOPE } from './claude-login-file.js'
import { CLAUDE_HOME, SCRATCH_ROOT, SETI_HOME, WORKTREE_ROOT } from './config.js'
import { connectionEnv } from './egress-connections.js'
import type { SandboxPlan, SshPlan } from './launch-plan.js'
import { borrowedServers, ownProjects, readHostConfig } from './mcp-borrowed.js'
import { launch, type ScopePlan } from './memory-scope.js'
import { memoryEnv } from './node-heap.js'
import { sandboxDirOf } from './owned-dirs.js'
import { modelProxyHere, proxyAwsToken, proxyGone, proxyHere, sshAgentHere } from './proxy-owner.js'
import { awsToken } from './sandbox-aws-token.js'
import { bwrapArgs } from './sandbox-bwrap.js'
import { sandboxClaudeJson } from './sandbox-claude-json.js'
import { CODEX_DIR, codexMountPoints, EMPTY_DIR, EMPTY_FILE, MODEL_KEY_ENV, SKILLS_HOME } from './sandbox-codex.js'
import { gitEnv } from './sandbox-git.js'
import { forgetSandboxSignIns, hostClaudeJson, mcpTokens, proxiedServers, signedInServers } from './sandbox-mcp.js'
import {
  checkoutOf,
  mountProblem,
  SANDBOX_CA,
  SANDBOX_RUN,
  SANDBOX_SSH_AGENT,
  sandboxMounts,
  type Maintenance,
  type SandboxLayout,
} from './sandbox-mounts.js'
import { prepareSandboxSsh } from './sandbox-ssh-files.js'
import { homeExcluded, type SandboxContext, sandboxHiddenPaths } from './sandbox.js'
import { SSH_AGENT_SOCKET, stopSshAgent } from './ssh-agent.js'
import {
  closeTaskProxy,
  maintenanceDirOf,
  openModelProxy,
  openTaskSsh,
  sandboxCaPublic,
  startProxy,
} from './task-proxy.js'
import { toolShellEnv, writeToolShell } from './tool-shell.js'
import { workspaceDir } from './workspace/dir.js'

/** The loopback port inside a sandbox where socat hands connections to the task's proxy socket. */
const PROXY_PORT = 3128
const PROXY_URL = `http://127.0.0.1:${String(PROXY_PORT)}`

/** What sandboxed processes hold instead of credentials; the proxy swaps in the real ones. */
export const CLAUDE_PLACEHOLDER = 'sk-ant-oat01-seti-sandbox-placeholder'
export const GITHUB_PLACEHOLDER = 'seti-sandbox-placeholder'

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
  /** A Codex agent: its runtime's home, and the connection variable that holds its OpenAI key. */
  codex?: { modelKey: string | null }
}

/** Where the sandbox sees the prefix its tools start through, in its read-only run directory. */
const SANDBOX_TOOL_SHELL = `${SANDBOX_RUN}/tool-shell`

/** Claude Code's model settings, or a Codex agent's home and its key's placeholder. */
function runtimeEnv(home: string, options: SandboxEnvOptions): Record<string, string> {
  if (options.codex === undefined) {
    return {
      ANTHROPIC_BASE_URL: PROXY_URL,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_PLACEHOLDER,
      ...(options.connectors ? { CLAUDE_CODE_OAUTH_SCOPES: `user:inference ${CONNECTOR_SCOPE}` } : {}),
    }
  }
  const { modelKey } = options.codex
  const placeholder = modelKey === null ? undefined : options.connections?.[modelKey]
  return {
    CODEX_HOME: path.join(home, CODEX_DIR),
    ...(placeholder === undefined ? {} : { [MODEL_KEY_ENV]: placeholder }),
  }
}

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
    ...runtimeEnv(home, options),
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

const taskDir = sandboxDirOf

/** The host directory a task's sandbox sees as /tmp. */
export const sandboxTmpDir = (taskId: string) => path.join(taskDir(taskId), 'tmp')

/** Stops a deleted task's proxy and removes its sandbox state. */
export async function removeTaskSandbox(taskId: string): Promise<void> {
  await proxyGone(taskId, async () => closeTaskProxy(taskId))
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
  /** What the control plane read for the sandbox; the sandbox reads nothing else. */
  plan: SandboxPlan
  /** The memory cap that holds the task's process trees, when the host enforces one. */
  memory?: MemoryCap | null
  /**
   * A maintenance session, such as a dream: its work folders read-only but its memory folder and
   * these, its own home and /tmp, and egress to the model provider only, with no credential but
   * the agent's Claude login.
   */
  maintenance?: Maintenance
}

/** The task's ssh files and agent for its usable hosts; none, and no agent, without any. */
async function sandboxSsh(taskId: string, plan: SshPlan | null, at: { dir: string; home: string; socat: string }) {
  if (plan === null) {
    await stopSshAgent(taskId)
    return null
  }
  const ssh = prepareSandboxSsh({ taskDir: at.dir, home: at.home, proxy: { socat: at.socat, port: PROXY_PORT }, plan })
  await sshAgentHere(taskId, async () => openTaskSsh(taskId))
  return ssh
}

function prepareDirs(dir: string): void {
  for (const sub of ['home', 'tmp', 'run']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 })
  }
  fs.chmodSync(dir, 0o700)
  writeToolShell(path.join(dir, 'run', path.basename(SANDBOX_TOOL_SHELL)))
}

interface Reach {
  ssh: { dir: string; agentDir: string } | null
  options: SandboxEnvOptions
}

/** The agent's proxy, ssh and environment as its plan grants them. */
async function grantedReach(task: Task, request: SandboxRequest, at: { dir: string; home: string; socat: string }) {
  const { plan } = request
  await proxyHere(task.id, plan.grant, async () => startProxy(task.id, plan.grant))
  const ssh = await sandboxSsh(task.id, plan.ssh, at)
  const options: SandboxEnvOptions = {
    github: plan.github,
    connectors: plan.connectors,
    aws:
      plan.aws === null
        ? null
        : { token: await proxyAwsToken(task.id, () => awsToken(task.id)), region: plan.aws.region },
    ssh: ssh !== null,
    memory: request.memory ?? null,
    connections: connectionEnv(plan.grant.connections),
    ...(plan.codex === undefined ? {} : { codex: plan.codex }),
  }
  return { ssh, options }
}

/**
 * A maintenance session's reach: the model provider through its own proxy, and nothing else. A
 * Codex plan's provider is OpenAI, reached with the connection that carries the agent's key.
 */
async function modelReach(task: Task, request: SandboxRequest): Promise<Reach> {
  const { grant, codex } = request.plan
  const key = codex === undefined ? null : (grant.connections.find((each) => each.env === codex.modelKey) ?? null)
  const reach = { login: grant.login, key }
  await modelProxyHere(task.id, reach, async () => openModelProxy(task.id, reach))
  const own = { github: false, connectors: false, memory: request.memory ?? null }
  if (codex === undefined) {
    return { ssh: null, options: own }
  }
  return { ssh: null, options: { ...own, codex, connections: connectionEnv(key === null ? [] : [key]) } }
}

/** Where a bare maintenance session of the agent works: an empty folder of its own. */
export const bareWorkDir = (taskId: string) => path.join(maintenanceDirOf(taskId), 'work')

/** The folders a sandbox works in: the agent's, or for a bare session only its empty folder. */
function workOf(task: Task, maintenance: Maintenance | undefined) {
  if (maintenance?.bare === true) {
    return { cwd: bareWorkDir(task.id), dirs: [], homeAccess: false, workspace: null }
  }
  return { cwd: task.cwd, dirs: extraDirs(task), homeAccess: task.home_access, workspace: workspaceDir(task.id) }
}

/** Checks the work folders can be mounted and makes the ones Seti owns. */
function prepareWork(layout: SandboxLayout): void {
  if (layout.maintenance?.bare === true) {
    fs.mkdirSync(layout.cwd, { recursive: true, mode: 0o700 })
    return
  }
  for (const workDir of [layout.cwd, ...layout.dirs]) {
    const problem = mountProblem(workDir, layout)
    if (problem !== null) {
      throw new Error(`The sandbox cannot run this agent: ${problem}. Start it without the sandbox instead.`)
    }
  }
  if (layout.workspace !== undefined && layout.workspace !== null) {
    fs.mkdirSync(layout.workspace, { recursive: true, mode: 0o700 })
  }
}

/** Claude Code's configuration in the agent's private home, filtered to what the agent may use. */
function prepareClaude(task: Task, plan: SandboxPlan, layout: SandboxLayout): void {
  const projects = [task.cwd, checkoutOf(task.cwd, layout) ?? task.cwd]
  const denied = new Set(plan.denied)
  sandboxClaudeJson(hostClaudeJson(), path.join(layout.taskDir, 'home', '.claude.json'), {
    signedIn: signedInServers(),
    projects: [...new Set(projects)],
    denied,
    covered: (host) =>
      plan.grant.connections.some(
        (each) => each.header !== null && each.hosts.some((pattern) => hostMatches(pattern, host)),
      ),
    borrowed: borrowedServers(readHostConfig(), ownProjects(task.cwd), (name) => plan.borrowed.includes(name)),
  })
  forgetSandboxSignIns(path.join(layout.taskDir, 'home', '.claude'), proxiedServers(mcpTokens, denied))
}

/** Codex's home in the agent's private home, with the places its locked files are mounted on. */
function prepareCodex(dir: string): void {
  const { files, dirs } = codexMountPoints(path.join(dir, 'home'))
  const skillsHome = [path.join(dir, SKILLS_HOME), path.join(dir, SKILLS_HOME, 'skills')]
  for (const folder of [path.join(dir, 'home', CODEX_DIR), path.join(dir, EMPTY_DIR), ...skillsHome, ...dirs]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  }
  for (const file of [...files, path.join(dir, EMPTY_FILE)]) {
    fs.closeSync(fs.openSync(file, 'a', 0o600))
  }
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
  const { ctx, plan } = request
  const { policy } = plan
  const maintenance = request.maintenance
  const dir = maintenance === undefined ? taskDir(task.id) : maintenanceDirOf(task.id)
  const layout: SandboxLayout = {
    home: ctx.home,
    setiHome: SETI_HOME,
    worktreeRoot: WORKTREE_ROOT,
    claudeHome: CLAUDE_HOME,
    taskDir: dir,
    ...workOf(task, maintenance),
    ownRoot: SCRATCH_ROOT,
    readOnly: plan.readOnly,
    caDir: '',
    systemBundle: null,
    hidden: sandboxHiddenPaths(policy, ctx),
    excluded: homeExcluded(ctx),
    pathEnv: process.env.PATH ?? '',
    sessionId: maintenance === undefined ? task.session_id : null,
    ...(maintenance === undefined ? {} : { maintenance }),
    ...(plan.codex === undefined ? {} : { codex: true }),
  }
  prepareWork(layout)
  prepareDirs(dir)
  if (plan.codex !== undefined) {
    prepareCodex(dir)
  } else if (maintenance?.bare !== true) {
    prepareClaude(task, plan, layout)
  }
  const reach =
    maintenance === undefined
      ? await grantedReach(task, request, { dir, home: ctx.home, socat })
      : await modelReach(task, request)
  const authority = await sandboxCaPublic()
  const ready = { ...layout, caDir: authority.publicDir, systemBundle: authority.systemBundle, ssh: reach.ssh }
  const env = sandboxEnv(process.env, ctx.home, reach.options)
  const command = (program: string, args: readonly string[], options: SandboxCommandOptions = {}) => {
    const extra = path.isAbsolute(program) ? [program] : []
    const mounts = sandboxMounts({ ...ready, readOnly: [...ready.readOnly, ...extra] })
    const init = ['--', '/bin/sh', '-c', initScript(setpriv, socat), 'seti', program]
    const argv = [...bwrapArgs(mounts, layout.cwd, options.interactive === true), ...init, ...args]
    const scope = options.scope ?? null
    const base = options.env ?? env
    if (scope === null) {
      return { program: bwrap, args: argv, env: { ...base } }
    }
    // systemd-run needs the user bus; the sandbox never sees where it is.
    return {
      program: envBinary,
      args: ['-u', 'XDG_RUNTIME_DIR', bwrap, ...argv],
      env: { ...base, XDG_RUNTIME_DIR: scope.host.runtimeDir },
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

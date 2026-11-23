import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extraDirs, type MemoryCap, type Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { CLAUDE_HOME, CREDENTIALS, DATABASE_URL, REDIS_URL, SETI_HOME } from './config.js'
import { projectSettingsRules, userSettingsRules } from './inherited-rules.js'
import { memoryEnv } from './node-heap.js'
import type { GuardScope } from './permission-guard.js'
import { builtInRules, composeRules, type PermissionSettings } from './permission-policy.js'
import type { RuleSources } from './policy/sources.js'
import { mcpTargets } from './sandbox-mcp.js'
import { secretDenyRules, setiHomePaths, unsandboxedHookRules, type SandboxContext } from './sandbox.js'
import { keyStamp, sshStamp } from './ssh-files.js'
import { profiles } from './store/credentials.js'
import { permissionRules } from './store/permissions.js'
import { sandboxPolicy } from './store/sandbox.js'
import { profileStamp } from './task-credentials.js'
import { hostToolShell, toolShellEnv } from './tool-shell.js'
import { workspaceDir } from './workspace/dir.js'

/**
 * Returns extra system prompt text for a task, or null when it has nothing to add.
 * @public
 */
export type ContextProvider = (taskId: string) => string | null | Promise<string | null>

const contextProviders: ContextProvider[] = []

/** @public */
export function registerContextProvider(provider: ContextProvider): void {
  contextProviders.push(provider)
}

export async function systemAppend(taskId: string): Promise<string> {
  const extra = await Promise.all(contextProviders.map(async (provider) => provider(taskId)))
  return extra.filter((text) => text !== null).join('\n\n')
}

/** The server's environment for an unsandboxed process tree, sized to the cap that holds it. */
export function agentEnv(cap: MemoryCap | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ANTHROPIC_API_KEY') {
      env[key] = value
    }
  }
  return { ...env, ...hostLimitsEnv(cap) }
}

/** The heap size and tool prefix of a process tree on the host, under the cap that holds it. */
export const hostLimitsEnv = (cap: MemoryCap | null): Record<string, string> => ({
  ...memoryEnv(process.env.NODE_OPTIONS, cap),
  ...(cap === null ? {} : toolShellEnv(hostToolShell())),
})

/** The folders besides cwd the agent works in: its repos and dirs, then its Seti workspace. */
export const workingDirs = (task: Task) =>
  [...new Set([...extraDirs(task), workspaceDir(task.id)])].filter((dir) => dir !== task.cwd)

/** The database and cache socket directories, which no sandbox mounts. */
function socketDirs(): string[] {
  const database = new URL(DATABASE_URL).searchParams.get('host')
  const dirs = [database ?? '', REDIS_URL.startsWith('/') ? path.dirname(REDIS_URL) : '']
  return dirs.filter((dir) => dir.startsWith('/') && fs.existsSync(dir)).map((dir) => fs.realpathSync(dir))
}

/** The per-user credentials root systemd fills, and the server's own directory when elsewhere. */
function credentialDirs(): string[] {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(os.userInfo().uid)}`
  const root = path.join(runtime, 'credentials')
  const own = CREDENTIALS.dev ? null : CREDENTIALS.dir
  return own === null || own.startsWith(`${root}/`) ? [root] : [root, own]
}

export function sandboxContext(): SandboxContext {
  return {
    home: os.homedir(),
    setiHome: SETI_HOME,
    claudeHome: CLAUDE_HOME,
    sockets: socketDirs(),
    credentials: credentialDirs(),
  }
}

/** Names the task in its process's environment, so the resource sampler can tell processes apart. */
export const TASK_ID_ENV = 'SETI_TASK_ID'

/** The ssh hosts a task can use, with the hosts, keys and host keys its files render. */
async function sshSetup(taskId: string) {
  const reach = await taskSsh(taskId)
  return reach.usable.length === 0
    ? null
    : {
        hosts: reach.usable,
        rendered: reach.hosts,
        keys: await keyStamp(reach.hosts),
        known: await sshStamp(reach.knownHosts),
      }
}

/** What a task's sandbox is made of; a process in it needs a new sandbox when this changes. */
export const sandboxStamp = async (task: Task) => ({
  ...(await sandboxPolicy.get()),
  updated_at: null,
  task: task.sandbox,
  home: task.home_access,
  profile: await profileStamp(task),
  mcp: mcpTargets(),
  aws: (await taskAws(task.id)) ? ((await profiles.get(task.profile_id))?.aws.region ?? null) : null,
  ssh: await sshSetup(task.id),
})

const GUARDED_HOME = ['.ssh', '.aws', '.config']

/** Edits under the home folders that hold credentials and settings, for every agent. */
const guardedEdits = (home: string) =>
  GUARDED_HOME.flatMap((dir) => [`Edit(/${path.join(home, dir)})`, `Edit(/${path.join(home, dir)}/**)`])

/** Seti's own rules for the task's agent, by source, without Claude Code's settings files. */
async function setiRules(task: Task): Promise<Omit<RuleSources, 'inherited'>> {
  const policy = await sandboxPolicy.get()
  const sandboxed = policy.enabled && task.sandbox
  const ctx = sandboxContext()
  const secrets = [...secretDenyRules(policy, ctx), ...guardedEdits(ctx.home)]
  return {
    builtIn: builtInRules(),
    sandboxed,
    workspace: `Edit(/${workspaceDir(task.id)}/**)`,
    stored: [...(await permissionRules.list(null)), ...(await permissionRules.list(task.id))],
    fixedDeny: sandboxed ? [...secrets, ...unsandboxedHookRules()] : secrets,
    cwd: task.cwd,
  }
}

/** Every rule the task's agent runs with, by source, Claude Code's settings files included. */
export async function ruleSources(task: Task): Promise<RuleSources> {
  const inherited = [
    ...userSettingsRules().map((rule) => ({ ...rule, anchor: CLAUDE_HOME })),
    ...projectSettingsRules(task.cwd).map((rule) => ({ ...rule, anchor: task.cwd })),
  ]
  return { ...(await setiRules(task)), inherited }
}

/**
 * The allow, ask and deny rules the task's agent runs with: built-in, edits in its workspace,
 * global and its own, with the deny rules that keep credentials out of every task and hooks out
 * of sandboxed ones.
 */
export async function permissionSettings(task: Task): Promise<PermissionSettings> {
  const own = await setiRules(task)
  return composeRules({
    builtIn: own.builtIn,
    sandboxed: own.sandboxed,
    stored: [{ behavior: 'allow', rule: own.workspace }, ...own.stored],
    fixedDeny: own.fixedDeny,
  })
}

const GUARDED_SETI = ['credentials', 'dev-credentials']

/** Where the task's agent may remove trees, and the credentials it never writes under. */
export function guardScope(task: Task, sandboxed: boolean): GuardScope {
  const ctx = sandboxContext()
  return {
    home: ctx.home,
    sandboxed,
    roots: [task.cwd, ...extraDirs(task), workspaceDir(task.id)],
    protectedDirs: [
      ...GUARDED_HOME.map((dir) => path.join(ctx.home, dir)),
      ...setiHomePaths(ctx).flatMap((home) => GUARDED_SETI.map((dir) => path.join(home, dir))),
    ],
  }
}

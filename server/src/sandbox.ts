import path from 'node:path'
import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { urlAllowed, WEBFETCH_BLOCKED, type SandboxPolicy } from '@seti/shared'

/** Where credentials live on this machine. */
export interface SandboxContext {
  home: string
  setiHome: string
  claudeHome: string
  /** Real directories of the database and cache sockets. */
  sockets: readonly string[]
  /** Where systemd puts the credentials of this user's services while they run. */
  credentials: readonly string[]
}

/** Credentials no task reads, relative to the home directory. */
const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.config/gh',
  '.config/gcloud',
  '.config/**/*.env',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.cloudflared',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.gnupg',
  '.password-store',
  '.vault-token',
  '.terraform.d',
  '.mcp-auth',
  '.claude.json',
  '.local/share/keyrings',
  '.local/share/com.vercel.cli',
  '.cargo/credentials.toml',
  '.cargo/credentials',
] as const

/**
 * Top-level home folders no sandbox mounts, though they hold no dot: the deployed Seti checkout
 * runs on the host at its next restart, and the CI runner keeps its registration.
 */
const HOME_EXCLUDED = ['seti-live', 'actions-runner', 'snap'] as const

/** Seti's files with keys, transcripts and backups; not all of its home, which holds worktrees. */
const SETI_SECRETS = ['*.env', 'seti.db*', 'backups', 'credentials', 'dev-credentials', 'sandbox-ca'] as const

/** Files whose settings or hooks run outside the sandbox, so sandboxed agents cannot edit them. */
const RUNS_UNSANDBOXED = [
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '**/.claude/hooks',
  '**/.mcp.json',
]

const inHome = (ctx: SandboxContext, relative: string) => path.join(ctx.home, relative)

/** Seti's home, and the default one when SETI_HOME points elsewhere, as for a scratch instance. */
const setiHomes = (ctx: SandboxContext) => [...new Set([ctx.setiHome, inHome(ctx, '.seti')])]

const setiSecrets = (ctx: SandboxContext) =>
  setiHomes(ctx).flatMap((home) => SETI_SECRETS.map((name) => path.join(home, name)))

/** Absolute paths hidden from every task, before the policy's own. */
function hiddenPaths(ctx: SandboxContext): string[] {
  const claudeCredentials = [inHome(ctx, '.claude/.credentials.json'), path.join(ctx.claudeHome, '.credentials.json')]
  const homeSecrets = HOME_SECRETS.map((secret) => inHome(ctx, secret))
  return [...new Set([...homeSecrets, ...claudeCredentials, ...ctx.sockets, ...ctx.credentials])]
}

const expandHome = (ctx: SandboxContext, entry: string) =>
  entry.startsWith('~/') ? inHome(ctx, entry.slice(2)) : entry

const allHidden = (policy: SandboxPolicy, ctx: SandboxContext) => [
  ...hiddenPaths(ctx),
  ...setiSecrets(ctx),
  ...policy.hidden_paths.map((entry) => expandHome(ctx, entry)),
]

export const homeExcluded = (ctx: SandboxContext) => HOME_EXCLUDED.map((name) => inHome(ctx, name))

/** How the settings page lists what every task hides, with the home directory as ~. */
export function builtInHidden(ctx: SandboxContext): string[] {
  const tilde = (entry: string) => (entry.startsWith(`${ctx.home}/`) ? `~${entry.slice(ctx.home.length)}` : entry)
  return [...hiddenPaths(ctx), ...setiSecrets(ctx), ...homeExcluded(ctx)].map(tilde)
}

/** The hidden paths a sandbox covers up where a mounted directory holds them; bwrap has no globs. */
export const sandboxHiddenPaths = (policy: SandboxPolicy, ctx: SandboxContext): string[] =>
  [...allHidden(policy, ctx), ...homeExcluded(ctx)].filter((entry) => !entry.includes('*'))

/** Everything the Files view never serves, globs included, with Seti's other homes by name. */
export const filesHiddenPaths = (policy: SandboxPolicy, ctx: SandboxContext): string[] => [
  ...allHidden(policy, ctx),
  ...homeExcluded(ctx),
]

/** Seti's home and the default one, which only a task's own worktree and workspace open into. */
export const setiHomePaths = (ctx: SandboxContext): string[] => setiHomes(ctx)

/** A path in permission rule syntax, where absolute paths start with //. */
const rulePath = (entry: string) => (entry.startsWith('/') ? `/${entry}` : entry)

function denyRules(tool: 'Read' | 'Edit', entries: readonly string[]): string[] {
  return entries.flatMap((entry) => [`${tool}(${rulePath(entry)})`, `${tool}(${rulePath(entry)}/**)`])
}

/** Rules keeping file tools, and file commands such as cat, off credentials in every task. */
export function secretDenyRules(policy: SandboxPolicy, ctx: SandboxContext): string[] {
  const secrets = allHidden(policy, ctx)
  return [...denyRules('Read', secrets), ...denyRules('Edit', secrets)]
}

/** Keeps sandboxed agents off files whose hooks would run when someone works there unsandboxed. */
export const unsandboxedHookRules = (): string[] =>
  denyRules(
    'Edit',
    RUNS_UNSANDBOXED.map((entry) => `/${entry}`),
  )

/** The proxy refuses other hosts too; the hook says why before a request is made. */
function webFetchGuard(allowed: () => Promise<readonly string[]>): HookCallback {
  return async (input) => {
    const url = input.hook_event_name === 'PreToolUse' ? readUrl(input.tool_input) : null
    if (url !== null && urlAllowed(url, await allowed())) {
      return {}
    }
    const reason = `${WEBFETCH_BLOCKED}: ${url ?? 'this URL'} is not on it. Ask the user to add the host in Seti.`
    return Promise.resolve({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })
  }
}

function readUrl(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null || !('url' in toolInput)) {
    return null
  }
  return typeof toolInput.url === 'string' ? toolInput.url : null
}

/** Hooks of a sandboxed task: WebFetch held to the allowlist its egress proxy enforces. */
export const sandboxHooks = (
  allowed: () => Promise<readonly string[]>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
  PreToolUse: [{ matcher: 'WebFetch', hooks: [webFetchGuard(allowed)] }],
})

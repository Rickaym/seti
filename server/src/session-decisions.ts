import type { CanUseTool, HookCallbackMatcher, HookEvent, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { compactHook } from './compact.js'
import { guardRefuses, type GuardScope } from './permission-guard.js'
import { canUseToolFor } from './permission-requests.js'
import { repeatHooks } from './repeat-hooks.js'
import { reviewHook } from './review-hooks.js'
import { inProcessSandboxAccess, type SandboxAccess } from './sandbox-access.js'
import { sandboxHooks } from './sandbox.js'
import { redactSecrets } from './scrub.js'
import { permissionSettings } from './session-spec.js'
import { allowedFor } from './store/change-requests.js'

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>

/** What a session's process asks Seti while it runs: each answer reads or writes Seti's records. */
export interface SessionDecisions {
  canUseTool: (taskId: string, session: AbortSignal) => CanUseTool
  /** Records a command the shell guard refused, so the user sees what the agent tried. */
  guardRefused: (task: Task) => (command: string, reason: string) => Promise<void>
  /** The review, repeat and (when sandboxed) WebFetch hooks, which wait on Seti's answers. */
  hooks: (task: Task, scope: GuardScope, session: AbortSignal) => Hooks
  compact: (taskId: string) => HookCallbackMatcher
  /** Servers that answer inside Seti, such as the seti tools, keyed by name. */
  servers: (task: Task) => Record<string, McpServerConfig>
  /** What the task's sandbox and its egress proxy read from Seti's records and secrets. */
  sandbox: SandboxAccess
}

/**
 * Builds MCP servers that run inside Seti's own process for a task's session, keyed by name.
 * @public
 */
export type SessionMcpServers = (task: Task) => Record<string, McpServerConfig>

const sessionMcpFactories: SessionMcpServers[] = []

/** @public */
export function registerSessionMcpServers(factory: SessionMcpServers): void {
  sessionMcpFactories.push(factory)
}

const COMMAND_CHARS = 500

/** The guard's refusals go to the audit log, so the user sees what an agent tried. */
const auditRefusal = (task: Task) => async (command: string, reason: string) => {
  const shown = redactSecrets(command).slice(0, COMMAND_CHARS)
  await audit.record({
    actor: 'system',
    kind: 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Refused a command of task "${task.title}": ${reason}`,
    detail: { title: task.title, tool: 'Bash', command: shown, guard: true },
  })
}

function decisionHooks(task: Task, scope: GuardScope, session: AbortSignal): Hooks {
  const sandbox = scope.sandboxed ? (sandboxHooks(async () => allowedFor(task.id)).PreToolUse ?? []) : []
  const repeat = repeatHooks({ task, session, refused: (tool, input) => guardRefuses(tool, input, scope) })
  const review = reviewHook({ taskId: task.id, session, denyRules: async () => (await permissionSettings(task)).deny })
  return { ...repeat, PreToolUse: [...sandbox, review, ...(repeat.PreToolUse ?? [])] }
}

/** The answers when the session runs in Seti's own process, straight from its records. */
export const inProcessDecisions: SessionDecisions = {
  canUseTool: canUseToolFor,
  guardRefused: auditRefusal,
  hooks: decisionHooks,
  compact: compactHook,
  servers: (task) =>
    Object.assign({}, ...sessionMcpFactories.map((factory) => factory(task))) as Record<string, McpServerConfig>,
  sandbox: inProcessSandboxAccess,
}

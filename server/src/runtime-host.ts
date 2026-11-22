import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { compactHook } from './compact.js'
import { subagentRules } from './house-rules.js'
import { bashGuard, guardRefuses } from './permission-guard.js'
import { canUseToolFor } from './permission-requests.js'
import { repeatHooks } from './repeat-hooks.js'
import { reviewHook } from './review-hooks.js'
import type { DefaultHost, DefaultShapes } from './runtimes/registry.js'
import { sandboxHooks } from './sandbox.js'
import { redactSecrets } from './scrub.js'
import { guardScope, permissionSettings } from './session-options.js'
import { shadowHooks } from './shadow-hooks.js'
import { allowedFor } from './store/change-requests.js'

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

const inProcessServers = (task: Task): Record<string, McpServerConfig> =>
  Object.assign({}, ...sessionMcpFactories.map((factory) => factory(task))) as Record<string, McpServerConfig>

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

/**
 * Hooks of every task: the guards, a sandboxed one's WebFetch allowlist, rules for subagents, and
 * the task's compaction instructions.
 */
function sessionHooks(task: Task, sandboxed: boolean, session: AbortSignal): DefaultShapes['hooks'] {
  const scope = guardScope(task, sandboxed)
  const guard = bashGuard(scope, auditRefusal(task))
  const sandbox = sandboxed ? (sandboxHooks(async () => allowedFor(task.id)).PreToolUse ?? []) : []
  const repeat = repeatHooks({ task, session, refused: (tool, input) => guardRefuses(tool, input, scope) })
  const review = reviewHook({ taskId: task.id, session, denyRules: async () => (await permissionSettings(task)).deny })
  const PreToolUse = [guard, ...sandbox, review, ...(repeat.PreToolUse ?? [])]
  return { ...repeat, PreToolUse, SubagentStart: [subagentRules()], PreCompact: [compactHook(task.id)] }
}

type Hooks = DefaultShapes['hooks']

/** Both sets of hooks, each event's matchers in order. */
function withHooks(first: Hooks, second: Hooks): Hooks {
  const events = [...new Set([...Object.keys(first), ...Object.keys(second)])] as (keyof Hooks)[]
  return Object.fromEntries(events.map((event) => [event, [...(first[event] ?? []), ...(second[event] ?? [])]]))
}

/**
 * What Seti answers for a task's session while its turns wait, until the session ends. Seti's own
 * permission evaluator runs beside, in shadow, and changes no answer.
 */
export const sessionHost = (task: Task, sandboxed: boolean, session: AbortSignal): DefaultHost => {
  const shadow = shadowHooks(task, sandboxed, session)
  return {
    decide: shadow.observe(canUseToolFor(task.id, session)),
    hooks: withHooks(sessionHooks(task, sandboxed, session), shadow.hooks),
    toolServers: inProcessServers(task),
  }
}

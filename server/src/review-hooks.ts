import type { HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { askForReview } from './permission-requests.js'
import { permissionSettings } from './session-options.js'
import { permissionRules } from './store/permissions.js'

/** Whether a rule names the MCP tool: the tool itself, or its server, bare or as server__*. */
export function namesTool(rule: string, tool: string): boolean {
  const server = rule.endsWith('__*') ? rule.slice(0, -3) : rule
  return rule === tool || tool.startsWith(`${server}__`)
}

async function reviewed(taskId: string, tool: string): Promise<boolean> {
  const rules = [...(await permissionRules.list(null)), ...(await permissionRules.list(taskId))]
  return rules.some((rule) => rule.behavior === 'review' && namesTool(rule.rule, tool))
}

const decide = (
  permissionDecision: 'allow' | 'deny',
  extra: { permissionDecisionReason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string },
): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } })

/**
 * Holds an MCP call a review rule names until the user allows it, with their edits, or denies it,
 * and answers what the agent's review hook returns; as a hook it asks in Bypass too. A call the
 * agent's deny rules refuse is left to them, never reviewed. When the user's edits ran, the hook
 * adds Seti's note of them, which the agent reads right after the call's result.
 */
export async function reviewCall(
  task: Task,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
): Promise<HookJSONOutput> {
  const { tool, input } = call
  if (!(await reviewed(task.id, tool)) || (await permissionSettings(task)).deny.some((rule) => namesTool(rule, tool))) {
    return {}
  }
  const { result, note } = await askForReview(task.id, call, [signal])
  if (result.behavior === 'deny') {
    return decide('deny', { permissionDecisionReason: result.message })
  }
  const updatedInput = result.updatedInput ?? input
  return decide('allow', note === undefined ? { updatedInput } : { updatedInput, additionalContext: note })
}

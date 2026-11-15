import type { HookCallback, HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { askForReview } from './permission-requests.js'
import { ASK_TIMEOUT_S, asRecord } from './repeat-hooks.js'
import { permissionRules } from './store/permissions.js'

export interface ReviewScope {
  taskId: string
  /** Aborts when the session closes, which drops a review still open. */
  session: AbortSignal
  /** The deny rules the agent runs with; a call one refuses is left to it, never reviewed. */
  denyRules: () => Promise<readonly string[]>
}

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
  extra: { permissionDecisionReason?: string; updatedInput?: Record<string, unknown> },
): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } })

const UNCHECKED = 'Seti could not check its review rules, so it held this call back. Tell the user.'

/**
 * A PreToolUse hook that holds each MCP call a review rule names until the user allows it, with
 * their edits, or denies it; as a hook it asks in Bypass too.
 */
export function reviewHook(scope: ReviewScope): HookCallbackMatcher {
  const check = async (tool: string, input: Record<string, unknown>, signal: AbortSignal) => {
    if (!(await reviewed(scope.taskId, tool)) || (await scope.denyRules()).some((rule) => namesTool(rule, tool))) {
      return {}
    }
    const answer = await askForReview(scope.taskId, { tool, input }, [signal, scope.session])
    return answer.behavior === 'deny'
      ? decide('deny', { permissionDecisionReason: answer.message })
      : decide('allow', { updatedInput: answer.updatedInput ?? input })
  }

  const hook: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    try {
      return await check(input.tool_name, asRecord(input.tool_input), signal)
    } catch (e) {
      process.stderr.write(`review hook: task ${scope.taskId}: ${String(e)}\n`)
      return decide('deny', { permissionDecisionReason: UNCHECKED })
    }
  }
  return { matcher: 'mcp__.*', hooks: [hook], timeout: ASK_TIMEOUT_S }
}

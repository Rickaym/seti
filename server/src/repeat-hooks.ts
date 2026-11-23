import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import type { NodeAnswer } from '@seti/shared'
import { callKey, RepeatTracker, resultKey } from './repeat-guard.js'

/** How long the question may wait for the user, in seconds, as a permission request may. */
export const ASK_TIMEOUT_S = 7 * 24 * 60 * 60

/** Calls whose start Seti saw and whose result has not come yet, at most this many. */
const OPEN_MAX = 1000

export interface RepeatScope {
  taskId: string
  /** Aborts when the session closes, which drops a question still open. */
  session: AbortSignal
  /** True when another guard refuses the call anyway, so a question about it would be noise. */
  refused: (tool: string, input: unknown) => boolean
  /** Asks the user about a call repeated with the same result `results` times so far. */
  ask: (
    call: { tool: string; input: Record<string, unknown> },
    results: number,
    signal: AbortSignal,
  ) => Promise<NodeAnswer<'repeat.ask'>>
}

const threadOf = (input: { agent_id?: string }) => input.agent_id ?? ''

export const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null ? Object.fromEntries(Object.entries(input)) : {}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/** Builds the hooks that stop an agent repeating a call with the same result and ask the user. */
export function repeatHooks(scope: RepeatScope): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const tracker = new RepeatTracker()
  const open = new Map<string, string>()

  const check = async (input: PreToolUseHookInput, signal: AbortSignal): Promise<HookJSONOutput> => {
    const thread = threadOf(input)
    const call = callKey(input.tool_name, input.tool_input)
    open.set(input.tool_use_id, call)
    if (open.size > OPEN_MAX) {
      open.delete(open.keys().next().value ?? '')
    }
    const results = tracker.repeats(thread, call)
    if (results === 0 || scope.refused(input.tool_name, input.tool_input)) {
      return {}
    }
    const asked = { tool: input.tool_name, input: asRecord(input.tool_input) }
    const answer = await scope.ask(asked, results, AbortSignal.any([signal, scope.session]))
    if (answer.outcome === 'off') {
      return {}
    }
    if (answer.outcome === 'denied') {
      return deny(answer.message)
    }
    tracker.allowed(thread, call, answer.always)
    return {}
  }

  const pre: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    try {
      return await check(input, signal)
    } catch (e) {
      process.stderr.write(`repeat guard: task ${scope.taskId}: ${String(e)}\n`)
      return {}
    }
  }

  const finished = (input: HookInput): void => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') {
      return
    }
    const call = open.get(input.tool_use_id) ?? callKey(input.tool_name, input.tool_input)
    open.delete(input.tool_use_id)
    if (input.hook_event_name === 'PostToolUse') {
      tracker.ran(threadOf(input), call, resultKey(input.tool_response))
    } else if (input.is_interrupt === true) {
      tracker.reset(threadOf(input))
    } else {
      tracker.ran(threadOf(input), call, resultKey({ error: input.error }))
    }
  }

  const post: HookCallback = async (input) => {
    finished(input)
    return Promise.resolve({})
  }

  const prompted: HookCallback = async () => {
    tracker.resetAll()
    return Promise.resolve({})
  }

  return {
    UserPromptSubmit: [{ hooks: [prompted] }],
    PreToolUse: [{ hooks: [pre], timeout: ASK_TIMEOUT_S }],
    PostToolUse: [{ hooks: [post] }],
    PostToolUseFailure: [{ hooks: [post] }],
  }
}

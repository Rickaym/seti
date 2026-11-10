import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { askAboutRepeat } from './permission-requests.js'
import { callKey, repeatReason, RepeatTracker, resultKey } from './repeat-guard.js'
import { archiveSettings } from './store/archive.js'

/** How long the question may wait for the user, in seconds, as a permission request may. */
const ASK_TIMEOUT_S = 7 * 24 * 60 * 60

/** Calls whose start Seti saw and whose result has not come yet, at most this many. */
const OPEN_MAX = 1000

export interface RepeatScope {
  task: Pick<Task, 'id' | 'title'>
  /** Aborts when the session closes, which drops a question still open. */
  session: AbortSignal
  /** True when another guard refuses the call anyway, so a question about it would be noise. */
  refused: (tool: string, input: unknown) => boolean
}

const threadOf = (input: { agent_id?: string }) => input.agent_id ?? ''

const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null ? Object.fromEntries(Object.entries(input)) : {}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

async function auditStop(task: RepeatScope['task'], tool: string, reason: string, results: number): Promise<void> {
  await audit.record({
    actor: 'system',
    kind: 'task.repeat_stopped',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Stopped task "${task.title}" to ask the user: ${reason}`,
    detail: { title: task.title, tool, results },
  })
}

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
    if (!(await archiveSettings.get()).repeat_guard) {
      return {}
    }
    const reason = repeatReason(input.tool_name, results)
    await auditStop(scope.task, input.tool_name, reason, results)
    const answer = await askAboutRepeat(
      scope.task.id,
      { tool: input.tool_name, input: asRecord(input.tool_input) },
      reason,
      [signal, scope.session],
    )
    if (answer.behavior === 'deny') {
      return deny(answer.message)
    }
    tracker.allowed(thread, call, answer.decisionClassification === 'user_permanent')
    return {}
  }

  const pre: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    try {
      return await check(input, signal)
    } catch (e) {
      process.stderr.write(`repeat guard: task ${scope.task.id}: ${String(e)}\n`)
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

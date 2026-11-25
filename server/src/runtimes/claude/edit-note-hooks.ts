import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'

/** Notes kept for calls still to run, at most this many; the oldest goes first. */
const KEPT_MAX = 100

/**
 * Hands the agent Seti's note of the user's edits right after the edited call's result. A call
 * Claude Code asked about runs only after the answer, so its note waits here by tool use id.
 */
export function editNoteHooks() {
  const notes = new Map<string, string>()
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') {
      return Promise.resolve({})
    }
    const note = notes.get(input.tool_use_id)
    notes.delete(input.tool_use_id)
    return Promise.resolve(
      note === undefined
        ? {}
        : { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: note } },
    )
  }
  const matcher: HookCallbackMatcher = { matcher: 'mcp__.*', hooks: [hook] }
  return {
    /** Keeps the note for the call with this id until its result comes. */
    keep: (toolUseId: string | undefined, note: string | undefined) => {
      if (toolUseId === undefined || note === undefined) {
        return
      }
      notes.set(toolUseId, note)
      const oldest = notes.keys().next().value
      if (notes.size > KEPT_MAX && oldest !== undefined) {
        notes.delete(oldest)
      }
    },
    PostToolUse: [matcher],
    PostToolUseFailure: [matcher],
  }
}

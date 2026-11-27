import type { Task } from '@seti/shared'
import { outsidePushes, outsideText, type OutsidePush } from './outward-push.js'
import { askAboutPush } from './permission-requests.js'

/** What the agent's push hook returns: nothing to add, or the user's refusal. */
type PushOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string }
    }

/** The reason line of a request about these pushes, one clause each. */
export const pushReason = (pushes: readonly OutsidePush[]): string => [...new Set(pushes.map(outsideText))].join('; ')

/** The owners a `PushTo` rule would let through for these pushes. */
const ownersOf = (pushes: readonly OutsidePush[]) => pushes.flatMap((push) => (push.owner === null ? [] : [push.owner]))

/**
 * Holds a Claude agent's command that pushes, forks or writes outside the user's organisations
 * until the user answers, and answers what the agent's push hook returns. An allowed command goes
 * on to the runtime's own checks; nothing here loosens them.
 */
export async function pushCall(
  task: Task,
  call: { tool: string; id?: string | undefined; input: Record<string, unknown>; cwd: string },
  signal: AbortSignal,
): Promise<PushOutput> {
  const command = call.input.command
  if (typeof command !== 'string' || command === '') {
    return {}
  }
  const pushes = await outsidePushes(task, command, call.cwd)
  if (pushes.length === 0) {
    return {}
  }
  const asked = {
    tool: call.tool,
    callId: call.id,
    input: call.input,
    reason: pushReason(pushes),
    owners: ownersOf(pushes),
    shell: { command, cwd: call.cwd },
  }
  const answer = await askAboutPush(task.id, asked, [signal])
  if (answer.behavior !== 'deny') {
    return {}
  }
  const refused: PushOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: answer.message,
    },
  }
  return refused
}

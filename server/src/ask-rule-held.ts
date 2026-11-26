import os from 'node:os'
import { claudeToolCall } from '@seti/shared'
import { tasks } from './db.js'
import { decide } from './policy/evaluate.js'
import { sourcedRules } from './policy/sources.js'
import { policyCall } from './policy/tool-call.js'
import { ruleSources, workingDirs } from './session-options.js'

/** What the runtime says of an ask: the call's id, and the ask rule that forced it, if it says. */
interface Asked {
  toolUseID: string
  matchedAskRule?: unknown
}

/**
 * Whether an ask rule, not a missing allow rule, holds the call. Always would then add an allow
 * rule the ask rule overrides, so the request offers none.
 */
export async function askRuleHolds(
  taskId: string,
  tool: string,
  input: Record<string, unknown>,
  asked: Asked,
): Promise<boolean> {
  if (asked.matchedAskRule !== undefined) {
    return true
  }
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return false
  }
  const ctx = {
    mode: 'ask' as const,
    rules: sourcedRules(await ruleSources(task)),
    cwd: task.cwd,
    dirs: [task.cwd, ...workingDirs(task)],
    home: os.homedir(),
    classifier: false,
  }
  return decide(policyCall(claudeToolCall(asked.toolUseID, tool, input)), ctx).step === 'ask-rule'
}

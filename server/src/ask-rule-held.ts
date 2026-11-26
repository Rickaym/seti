import os from 'node:os'
import { claudeToolCall } from '@seti/shared'
import { tasks } from './db.js'
import { decide } from './policy/evaluate.js'
import { sourcedRules } from './policy/sources.js'
import { policyCall } from './policy/tool-call.js'
import type { SourcedRule } from './policy/types.js'
import { ruleSources, workingDirs } from './session-options.js'

/** What the runtime says of an ask: the call's id, and the ask rule that forced it, if it says. */
interface Asked {
  toolUseID: string
  matchedAskRule?: unknown
}

const RULE_CHARS = 80

const shorten = (rule: string) => (rule.length > RULE_CHARS ? `${rule.slice(0, RULE_CHARS - 3)}...` : rule)

/** Seti's reason line for a call an ask rule holds, naming the rule; Seti's own rules say so. */
const askRuleReason = (rule: string, builtIn = false): string =>
  `${builtIn ? "Seti's" : 'Your'} Ask rule holds this: ${shorten(rule)}`

/** The reason line for the rule a decision names by its ref, or null when it names none. */
export function reasonForRef(rules: readonly SourcedRule[], ref: string | null): string | null {
  const rule = ref === null ? undefined : rules.find((one) => one.ref === ref)
  return rule === undefined ? null : askRuleReason(rule.text, rule.ref.startsWith('builtin:'))
}

/** The rule the runtime says forced the ask, in rule syntax, or null when it says none. */
function matchedRule(matched: unknown): string | null {
  if (typeof matched !== 'object' || matched === null || !('toolName' in matched)) {
    return null
  }
  const { toolName } = matched
  const content = 'ruleContent' in matched ? matched.ruleContent : undefined
  if (typeof toolName !== 'string') {
    return null
  }
  return typeof content === 'string' && content !== '' ? `${toolName}(${content})` : toolName
}

/**
 * Seti's reason line when an ask rule, not a missing allow rule, holds the call, else null.
 * Always would then add an allow rule the ask rule overrides, so the request offers none.
 */
export async function askRuleHolds(
  taskId: string,
  tool: string,
  input: Record<string, unknown>,
  asked: Asked,
): Promise<string | null> {
  const matched = matchedRule(asked.matchedAskRule)
  if (matched !== null) {
    return askRuleReason(matched)
  }
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return null
  }
  const rules = sourcedRules(await ruleSources(task))
  const ctx = {
    mode: 'ask' as const,
    rules,
    cwd: task.cwd,
    dirs: [task.cwd, ...workingDirs(task)],
    home: os.homedir(),
    classifier: false,
  }
  const decision = decide(policyCall(claudeToolCall(asked.toolUseID, tool, input)), ctx)
  return decision.step === 'ask-rule' ? (reasonForRef(rules, decision.rule) ?? askRuleReason(tool)) : null
}

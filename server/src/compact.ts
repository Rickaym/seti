import type { HookCallbackMatcher, SDKCompactBoundaryMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  compactLabel,
  CONTEXT_WINDOW_KEY,
  type AuditActor,
  type CompactRule,
  type CompactSettings,
  type Task,
  type TaskCompactRule,
  type WithContextWindow,
} from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { compactSettings, taskCompactRules } from './store/compact.js'

/** The rule a task's sessions compact by: its own, else the default. */
export async function effectiveCompact(taskId: string): Promise<CompactRule> {
  return (await taskCompactRules.get(taskId)) ?? (await compactSettings.get()).rule
}

export const compactSettingsView = async (): Promise<CompactSettings> => compactSettings.get()

/** Saves the default rule; agents without a rule of their own start their next turn with it. */
export async function updateCompactSettings(rule: CompactRule, actor: AuditActor = 'user'): Promise<CompactSettings> {
  refuseAgent('change how agents compact their conversations')
  await compactSettings.set(rule)
  const saved = await compactSettings.get()
  await audit.record({
    actor,
    kind: 'system.compact_changed',
    subject_type: 'system',
    summary: `Set how agents compact their conversations: ${compactLabel(saved.rule)}`,
    detail: { ...saved.rule },
  })
  return saved
}

export async function taskCompact(taskId: string): Promise<TaskCompactRule> {
  const override = await taskCompactRules.get(taskId)
  return { override, effective: override ?? (await compactSettings.get()).rule }
}

/** Gives the task a rule of its own, or with null the default; its next turn starts with it. */
export async function setTaskCompact(
  task: Task,
  rule: CompactRule | null,
  actor: AuditActor = 'user',
): Promise<TaskCompactRule> {
  refuseAgent('change how an agent compacts its conversation')
  await taskCompactRules.set(task.id, rule)
  const result = await taskCompact(task.id)
  await audit.record({
    actor,
    kind: 'task.compact_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary:
      rule === null
        ? `Gave task "${task.title}" the default compaction rule`
        : `Gave task "${task.title}" a compaction rule of its own: ${compactLabel(result.effective)}`,
    detail: { title: task.title, ...result.effective, own: rule !== null },
  })
  return result
}

/** What a rule starts a session's process with; a change takes a new process. */
export const compactSetup = (rule: CompactRule) => ({
  settings: {
    autoCompactEnabled: rule.auto,
    ...(rule.window_k === null ? {} : { autoCompactWindow: rule.window_k * 1000 }),
  },
  env: rule.threshold_pct === null ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(rule.threshold_pct) },
})

/**
 * Claude Code adds what a PreCompact hook answers to the summary's instructions, beside any the
 * user gave /compact. The task's instructions are read when it compacts, so edits apply at once.
 */
export const compactHook = (taskId: string): HookCallbackMatcher => ({
  hooks: [
    async () => {
      const { instructions } = await effectiveCompact(taskId)
      return instructions === null ? {} : { systemMessage: instructions }
    },
  ],
})

/** A compact boundary keeps the context window it was measured against, for its percentage. */
export async function withContextWindow(m: SDKMessage, window: () => Promise<number | null>): Promise<SDKMessage> {
  if (m.type !== 'system' || m.subtype !== 'compact_boundary') {
    return m
  }
  const tokens = await window()
  if (tokens === null) {
    return m
  }
  const stored: WithContextWindow<SDKCompactBoundaryMessage> = { ...m, [CONTEXT_WINDOW_KEY]: tokens }
  return stored
}

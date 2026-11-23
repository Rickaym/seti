import {
  compactLabel,
  type AuditActor,
  type CompactRule,
  type CompactSettings,
  type Task,
  type TaskCompactRule,
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

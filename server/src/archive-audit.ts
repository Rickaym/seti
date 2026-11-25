import type { AutoArchiveSettings } from '@seti/shared'
import { audit } from './audit.js'

const dayWords = (days: number) => (days === 1 ? '1 day' : `${String(days)} days`)

function ruleWords(settings: AutoArchiveSettings, before: AutoArchiveSettings): string {
  const archive = settings.enabled ? `on, for COMPLETE agents idle ${dayWords(settings.days)} or more` : 'off'
  const turned = settings.resume_after_restart ? 'on' : 'off'
  const resume = settings.resume_after_restart === before.resume_after_restart ? '' : `; resume after restart ${turned}`
  if (settings.delete_after_days !== null) {
    return `${archive}; delete archived agents after ${dayWords(settings.delete_after_days)}${resume}`
  }
  return before.delete_after_days === null ? `${archive}${resume}` : `${archive}; keep archived agents${resume}`
}

const SETTING_KEYS = ['enabled', 'days', 'delete_after_days', 'resume_after_restart'] as const

async function auditRepeatGuard(on: boolean): Promise<void> {
  await audit.record({
    actor: 'user',
    kind: 'system.repeat_guard_changed',
    subject_type: 'system',
    summary: `Turned the repeat guard ${on ? 'on' : 'off'}`,
    detail: { repeat_guard: on },
  })
}

/** Audits a saved auto archive rule as Settings, Lifecycle does: the repeat guard on its own. */
export async function auditArchiveChange(before: AutoArchiveSettings, after: AutoArchiveSettings): Promise<void> {
  if (before.repeat_guard !== after.repeat_guard) {
    await auditRepeatGuard(after.repeat_guard)
  }
  if (SETTING_KEYS.some((key) => before[key] !== after[key])) {
    await audit.record({
      actor: 'user',
      kind: 'system.auto_archive_changed',
      subject_type: 'system',
      summary: `Set auto archive ${ruleWords(after, before)}`,
      detail: {
        enabled: after.enabled,
        days: after.days,
        delete_after_days: after.delete_after_days,
        resume_after_restart: after.resume_after_restart,
        was_enabled: before.enabled,
        was_days: before.days,
        was_delete_after_days: before.delete_after_days,
        was_resume_after_restart: before.resume_after_restart,
      },
    })
  }
}

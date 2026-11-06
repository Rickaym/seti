import { warmCacheSettingsInput, type WarmCacheSettingsInput, type WarmCacheStatus } from '@seti/shared'

export interface WarmCacheForm {
  enabled: boolean
  patterns: string
  max_mb: string
}

export const toWarmCacheForm = (settings: Omit<WarmCacheStatus['settings'], 'updated_at'>): WarmCacheForm => ({
  enabled: settings.enabled,
  patterns: settings.patterns.join('\n'),
  max_mb: String(settings.max_mb),
})

export const sameWarmCacheForm = (a: WarmCacheForm, b: WarmCacheForm) =>
  a.enabled === b.enabled && a.patterns.trim() === b.patterns.trim() && a.max_mb.trim() === b.max_mb.trim()

export function parseWarmCacheForm(form: WarmCacheForm): { input: WarmCacheSettingsInput } | { error: string } {
  const patterns = form.patterns
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const parsed = warmCacheSettingsInput.safeParse({ enabled: form.enabled, patterns, max_mb: Number(form.max_mb) })
  return parsed.success ? { input: parsed.data } : { error: parsed.error.issues[0]?.message ?? 'Check warm caches' }
}

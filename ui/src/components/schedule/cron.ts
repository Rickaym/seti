import { toString as describeCron } from 'cronstrue'

export const CUSTOM = 'custom'

export const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekly, Monday 09:00', cron: '0 9 * * 1' },
] as const

export const DEFAULT_CRON = '0 9 * * 1-5'

export const presetFor = (cron: string) => SCHEDULE_PRESETS.find((p) => p.cron === cron.trim())?.cron ?? CUSTOM

/** A cron expression in words, such as "At 09:00, Monday through Friday", else the expression. */
export function describeSchedule(cron: string): string {
  try {
    return describeCron(cron, { use24HourTimeFormat: true, verbose: false })
  } catch {
    return cron
  }
}

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

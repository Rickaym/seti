export const INTERVAL_UNITS = {
  minutes: { label: 'minutes', short: 'min', seconds: 60 },
  hours: { label: 'hours', short: 'h', seconds: 3600 },
  days: { label: 'days', short: 'd', seconds: 86_400 },
} as const

export type IntervalUnit = keyof typeof INTERVAL_UNITS

/** An interval in the largest unit that divides it evenly. */
export function splitInterval(seconds: number): { count: number; unit: IntervalUnit } {
  if (seconds % 86_400 === 0) {
    return { count: seconds / 86_400, unit: 'days' }
  }
  if (seconds % 3600 === 0) {
    return { count: seconds / 3600, unit: 'hours' }
  }
  return { count: Math.round(seconds / 60), unit: 'minutes' }
}

/** An interval as a short phrase: "15 min", "2 h", "1 d". */
export function intervalLabel(seconds: number): string {
  const { count, unit } = splitInterval(seconds)
  return `${String(count)} ${INTERVAL_UNITS[unit].short}`
}

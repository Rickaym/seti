const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Binary sizes, with one decimal from GB up: "312 MB", "2.4 GB". */
export function bytesLabel(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit >= 3 ? 1 : 0)} ${UNITS[unit] ?? 'B'}`
}

export const percentLabel = (value: number | null) => (value === null ? '-' : `${String(Math.round(value))}%`)

/** A process or host age: "42s", "12m", "3h 05m", "4d 2h". */
export function ageLabel(seconds: number | null): string {
  if (seconds === null) {
    return '-'
  }
  const s = Math.floor(seconds)
  if (s < 60) {
    return `${String(s)}s`
  }
  if (s < 3600) {
    return `${String(Math.floor(s / 60))}m`
  }
  const hours = Math.floor(s / 3600)
  if (hours < 24) {
    return `${String(hours)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  }
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

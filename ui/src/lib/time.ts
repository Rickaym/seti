const UNITS: [limit: number, size: number, suffix: string][] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86_400, 3600, 'h'],
  [Number.POSITIVE_INFINITY, 86_400, 'd'],
]

/** How long ago `iso` was, compact: "42s", "5m", "3h", "2d". */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  const [, size, suffix] = UNITS.find(([limit]) => seconds < limit) ?? [0, 86_400, 'd']
  return `${String(Math.round(seconds / size))}${suffix}`
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  return `${ageLabel(iso, now)} ago`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A running duration: "42s", "3m 05s", "1h 02m". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${String(seconds)}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${String(minutes)}m ${pad(seconds % 60)}s`
  }
  return `${String(Math.floor(minutes / 60))}h ${pad(minutes % 60)}m`
}

/** A span of time to come, to the minute: "25m", "2h 5m", "3d 4h". */
export function durationLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) {
    return `${String(minutes)}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${String(hours)}h ${String(minutes % 60)}m`
  }
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

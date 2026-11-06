const pad = (value: number) => String(value).padStart(2, '0')

/** ISO 8601 local time with its UTC offset, such as 2026-09-27T22:30:00+08:00. */
export function localIso(at: Date, offsetMinutes: number): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return `${shifted}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** The browser timezone and local time, sent with the offer so the EA knows the user clock. */
export function browserClock(at: Date = new Date()): { timezone: string; localTime: string } {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: localIso(at, -at.getTimezoneOffset()),
  }
}

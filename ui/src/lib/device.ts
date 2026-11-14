const DEVICE_KEY = 'seti.device.id'

let fallback: string | null = null

/** This browser's own id, kept in storage so its push subscription and focus reports match. */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY)
    if (stored !== null && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      return stored
    }
    const made = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, made)
    return made
  } catch {
    fallback ??= crypto.randomUUID()
    return fallback
  }
}

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/AppleWebKit\/.*Mobile\//, 'Web app'],
]

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux|X11/, 'Linux'],
]

const match = (table: readonly [RegExp, string][], ua: string) => table.find(([test]) => test.test(ua))?.[1]

/** The operating system a user agent names, such as Android, or undefined. */
export const deviceSystem = (ua: string): string | undefined => match(SYSTEMS, ua)

/** How the settings page names a device, such as Safari on iPhone. */
export function deviceLabel(ua: string): string {
  const browser = match(BROWSERS, ua) ?? 'Browser'
  const system = deviceSystem(ua)
  return system === undefined ? browser : `${browser} on ${system}`
}

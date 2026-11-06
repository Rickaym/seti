import type { ITheme } from '@xterm/xterm'

/** Which theme token each terminal colour takes. */
const TOKENS = {
  background: '--background',
  foreground: '--foreground',
  cursor: '--primary',
  cursorAccent: '--background',
  selectionBackground: '--accent',
  selectionForeground: '--accent-foreground',
  red: '--destructive',
  brightRed: '--destructive',
  green: '--success',
  brightGreen: '--success',
  yellow: '--warning-text',
  brightYellow: '--warning-text',
  blue: '--primary',
  brightBlue: '--primary',
  white: '--muted-foreground',
  brightWhite: '--foreground',
  brightBlack: '--muted-foreground',
} as const satisfies Partial<Record<keyof ITheme, string>>

const hex = (value: number) => value.toString(16).padStart(2, '0')

/** The terminal in Seti's theme, its tokens read as hex whatever colour space they use. */
export function terminalTheme(host: HTMLElement): ITheme {
  const probe = document.createElement('span')
  probe.hidden = true
  host.append(probe)
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const colourOf = (token: string): string | null => {
    probe.style.color = `var(${token})`
    const colour = getComputedStyle(probe).color
    if (context === null || colour === '') {
      return null
    }
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = colour
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  try {
    const entries = Object.entries(TOKENS).flatMap(([key, token]) => {
      const colour = colourOf(token)
      return colour === null ? [] : [[key, colour] as const]
    })
    return Object.fromEntries(entries)
  } finally {
    probe.remove()
  }
}

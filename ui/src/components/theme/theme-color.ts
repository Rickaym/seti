/** Resolves any CSS colour, oklch included, to hex, which every browser's theme-color accepts. */
function toHex(colour: string): string | null {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (ctx === null) {
    return null
  }
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** Tints the browser and installed-app title bar with the header colour of the active theme. */
export function syncThemeColor(): void {
  const card = getComputedStyle(document.documentElement).getPropertyValue('--card').trim()
  const hex = toHex(card)
  if (hex === null) {
    return
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = hex
  }
}

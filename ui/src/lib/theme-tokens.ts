import type { Rgb } from './agent-color'

/**
 * The theme tokens now on <html> as sRGB, read through the browser so color-mix and oklch come
 * out as sRGB; null where no canvas is available.
 */
export function readTokens<T extends string>(tokens: readonly T[]): Record<T, Rgb> | null {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (context === null) {
    return null
  }
  const probe = document.createElement('span')
  probe.hidden = true
  document.body.append(probe)
  const read = (token: string): Rgb => {
    probe.style.color = `var(${token})`
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = getComputedStyle(probe).color
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
    return [r / 255, g / 255, b / 255]
  }
  const colours = Object.fromEntries(tokens.map((token) => [token, read(token)])) as Record<T, Rgb>
  probe.remove()
  return colours
}

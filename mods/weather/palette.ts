/** A colour as 0-255 red, green and blue with 0-1 alpha. */
export type Rgba = readonly [number, number, number, number]

const TOKENS = {
  cloud: '--weather-cloud',
  cloudShade: '--weather-cloud-shade',
  cloudNight: '--weather-cloud-night',
  rain: '--weather-rain',
  snow: '--weather-snow',
  fog: '--weather-fog',
  lightning: '--weather-lightning',
  meteor: '--weather-meteor',
  star: '--daylight-star',
  dawn: '--daylight-dawn',
  dusk: '--daylight-dusk',
  sunLow: '--daylight-sun-low',
} as const

export type Palette = Record<keyof typeof TOKENS, Rgba>

const CLEAR: Rgba = [0, 0, 0, 0]

/** Reads the theme tokens under `element` as sRGB, letting a canvas parse any CSS colour syntax. */
export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element)
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  const resolve = (token: string): Rgba => {
    const value = style.getPropertyValue(token).trim()
    if (ctx === null || value === '') {
      return CLEAR
    }
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const entries = Object.entries(TOKENS).map(([name, token]) => [name, resolve(token)] as const)
  return Object.fromEntries(entries) as Palette
}

export const mix = (a: Rgba, b: Rgba, t: number): Rgba => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  a[3] + (b[3] - a[3]) * t,
]

const byte = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0')

/** The colour as #rrggbbaa with its alpha scaled by `alpha`, the form canvas styles take fastest. */
export const hex = (color: Rgba, alpha = 1): string =>
  `#${byte(color[0])}${byte(color[1])}${byte(color[2])}${byte(color[3] * alpha * 255)}`

/** Gamma-encoded sRGB, each channel from 0 to 1. */
export type Rgb = readonly [number, number, number]

/** A colour in OKLCH: lightness 0 to 1, chroma from 0, hue in degrees. */
export interface Lch {
  l: number
  c: number
  h: number
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

function oklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklch(rgb: Rgb): Lch {
  const [l, a, b] = oklab(rgb)
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

/** Linear sRGB of an OKLCH colour, which may fall outside 0 to 1 when it is out of gamut. */
function linearOf({ l, c, h }: Lch): Rgb {
  const [a, b] = [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3)
  const [x = 0, y = 0, z = 0] = lms
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ]
}

const inGamut = (lch: Lch) => linearOf(lch).every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** The colour at this lightness and hue with as much of the chroma as sRGB holds. */
function inSrgb(lch: Lch): Lch {
  if (inGamut(lch)) {
    return lch
  }
  let [lo, hi] = [0, lch.c]
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (inGamut({ ...lch, c: mid })) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return { ...lch, c: lo }
}

/** An OKLCH colour in sRGB, keeping its lightness and hue and giving up chroma to fit. */
export function rgbOfOklch(lch: Lch): Rgb {
  const [r = 0, g = 0, b = 0] = linearOf(inSrgb(lch)).map((v) => toGamma(clamp(v, 0, 1)))
  return [r, g, b]
}

const channel = (value: number) =>
  Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')

export const hexOf = (rgb: Rgb) => `#${rgb.map(channel).join('')}`

export function rgbOf(hex: string): Rgb {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return [r, g, b]
}

/** WCAG relative luminance. */
export const luminance = ([r, g, b]: Rgb) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

export function labDistance(a: Rgb, b: Rgb): number {
  const [x, y] = [oklab(a), oklab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

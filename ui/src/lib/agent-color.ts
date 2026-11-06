import { AGENT_COLOR_PRESETS, agentColorPreset, type AgentColor } from '@seti/shared'

/** Gamma-encoded sRGB, each channel from 0 to 1. */
export type Rgb = readonly [number, number, number]

interface Lch {
  l: number
  c: number
  h: number
}

export interface ThemeInk {
  background: Rgb
  card: Rgb
  popover: Rgb
  accent: Rgb
  foreground: Rgb
  mutedForeground: Rgb
  primary: Rgb
  warningText: Rgb
  warning: Rgb
  destructive: Rgb
}

export const THEME_INK_TOKENS = [
  '--background',
  '--card',
  '--popover',
  '--accent',
  '--foreground',
  '--muted-foreground',
  '--primary',
  '--warning-text',
  '--warning',
  '--destructive',
] as const

export const themeInk = (read: (token: (typeof THEME_INK_TOKENS)[number]) => Rgb): ThemeInk => ({
  background: read('--background'),
  card: read('--card'),
  popover: read('--popover'),
  accent: read('--accent'),
  foreground: read('--foreground'),
  mutedForeground: read('--muted-foreground'),
  primary: read('--primary'),
  warningText: read('--warning-text'),
  warning: read('--warning'),
  destructive: read('--destructive'),
})

/** An agent colour fitted to one theme, both as `#rrggbb`. */
export interface AgentInk {
  /** Row stripes, frames, focus rings and the caret. */
  stripe: string
  /** Behind the agent's header and its selected row; text on it keeps AA. */
  tint: string
}

/** A stripe is a mark, so it needs 3:1 on every surface it sits on. */
export const STRIPE_CONTRAST = 3
/** Text on a tint is body text. */
export const TINT_TEXT_CONTRAST = 4.5
/** How far, in OKLab, a stripe stays from the error and warning colours it can sit beside. */
export const STATUS_DISTANCE = 0.1
/** Inputs with less chroma than this are greys and get a neutral stripe and tint. */
export const NEUTRAL_CHROMA = 0.03

const STRIPE_BAND = { light: [0.4, 0.62], dark: [0.6, 0.82] } as const
const STRIPE_CHROMA = { floor: 0.07, light: 0.19, dark: 0.16 } as const
const TINT_STEP = { light: -0.04, dark: 0.075 } as const
const TINT_CHROMA = { share: 0.28, floor: 0.012, light: 0.035, dark: 0.04 } as const
const STEP = 0.005

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

const channel = (value: number) =>
  Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')

export const hexOf = (rgb: Rgb) => `#${rgb.map(channel).join('')}`

export function rgbOf(hex: string): Rgb {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return [r, g, b]
}

/** The colour rounded to the `#rrggbb` it is written as, so checks see what the page shows. */
function written(lch: Lch): Rgb {
  const [r = 0, g = 0, b = 0] = linearOf(inSrgb(lch)).map((v) => toGamma(clamp(v, 0, 1)))
  return rgbOf(hexOf([r, g, b]))
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

export function labDistance(a: Rgb, b: Rgb): number {
  const [x, y] = [oklab(a), oklab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** Lightnesses from `start` outwards, nearest first, within `lo` and `hi`. */
function* around(start: number, lo: number, hi: number): Generator<number> {
  for (let k = 0; k * STEP <= 1; k++) {
    for (const l of k === 0 ? [start] : [start + k * STEP, start - k * STEP]) {
      if (l >= lo && l <= hi) {
        yield l
      }
    }
  }
}

interface Fit {
  input: Lch
  neutral: boolean
  ink: ThemeInk
  scheme: 'light' | 'dark'
}

function fitTint({ input, neutral, ink, scheme }: Fit): Rgb {
  const dark = scheme === 'dark'
  const c = neutral ? 0 : clamp(input.c * TINT_CHROMA.share, TINT_CHROMA.floor, TINT_CHROMA[scheme])
  const text = [ink.foreground, ink.mutedForeground, ink.primary, ink.warningText]
  const start = clamp(oklch(ink.background).l + TINT_STEP[scheme], 0, 1)
  for (let l = start; dark ? l >= 0 : l <= 1; l += dark ? -STEP : STEP) {
    const tint = written({ l, c, h: input.h })
    if (text.every((fg) => contrast(fg, tint) >= TINT_TEXT_CONTRAST)) {
      return tint
    }
  }
  return ink.background
}

function fitStripe({ input, neutral, ink, scheme }: Fit, tint: Rgb): Rgb {
  const surfaces = [ink.background, ink.card, ink.popover, ink.accent, tint]
  const statuses = [ink.destructive, ink.warning, ink.warningText]
  const [lo, hi] = STRIPE_BAND[scheme]
  const start = lo + (hi - lo) * clamp(input.l, 0, 1)
  const fits = (stripe: Rgb) =>
    surfaces.every((surface) => contrast(stripe, surface) >= STRIPE_CONTRAST) &&
    statuses.every((status) => labDistance(stripe, status) >= STATUS_DISTANCE)
  const chromas = neutral ? [0] : [clamp(input.c, STRIPE_CHROMA.floor, STRIPE_CHROMA[scheme]), 0]
  for (const c of chromas) {
    for (const l of around(start, 0.15, 0.95)) {
      const stripe = written({ l, c, h: input.h })
      if (fits(stripe)) {
        return stripe
      }
    }
  }
  return ink.foreground
}

/** Fits an agent colour to a theme in OKLCH: hue kept, lightness and chroma moved until it reads. */
export function deriveAgentColor(color: AgentColor, ink: ThemeInk): AgentInk {
  const input = oklch(rgbOf(color))
  const fit: Fit = {
    input,
    neutral: input.c < NEUTRAL_CHROMA,
    ink,
    scheme: luminance(ink.background) < luminance(ink.foreground) ? 'dark' : 'light',
  }
  const tint = fitTint(fit)
  return { stripe: hexOf(fitStripe(fit, tint)), tint: hexOf(tint) }
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** How the colour is named to people: Teal for a preset, the hex otherwise. */
export const agentColorLabel = (color: AgentColor): string => {
  const preset = agentColorPreset(color)
  return preset === null ? color : capitalised(preset)
}

export const PRESET_SWATCHES = AGENT_COLOR_PRESETS.map((preset) => ({
  hex: preset.hex,
  label: capitalised(preset.name),
}))

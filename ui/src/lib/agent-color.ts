import {
  AGENT_COLOR_PRESETS,
  agentColorPreset,
  contrast,
  hexOf,
  labDistance,
  luminance,
  oklch,
  rgbOf,
  rgbOfOklch,
  type AgentColor,
  type Lch,
  type Rgb,
} from '@seti/shared'

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

/** The colour rounded to the `#rrggbb` it is written as, so checks see what the page shows. */
const written = (lch: Lch): Rgb => rgbOf(hexOf(rgbOfOklch(lch)))

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

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

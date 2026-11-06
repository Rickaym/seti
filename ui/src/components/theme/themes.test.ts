import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AGENT_COLOR_PRESETS, DEFAULT_THEME } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  contrast,
  deriveAgentColor,
  hexOf,
  labDistance,
  NEUTRAL_CHROMA,
  oklch as lchOf,
  rgbOf,
  STATUS_DISTANCE,
  STRIPE_CONTRAST,
  themeInk,
  TINT_TEXT_CONTRAST,
  type ThemeInk,
} from '@/lib/agent-color'
import { colourTokens, themeModFiles, type ThemeModFile } from '@/mods/theme-mod-files'
import { applyTheme } from './apply'
import type { ThemeDefinition } from './registry'
import { blocks, cascade, fromOklch, hueGap, resolve, rules, srgbOf, type ThemeState } from './theme-cascade'

const read = (file: string) => readFileSync(path.join(import.meta.dirname, file), 'utf8')

const sorted = (names: Iterable<string> | undefined) => [...(names ?? [])].sort((a, b) => a.localeCompare(b))

const defaultCss = read('themes/default.css')
const defaults = blocks(defaultCss)
const tokens = sorted(defaults.get(':root'))
const colours = colourTokens()

/** Every theme the mods in mods/ add, so each one meets the same bar as Seti's own. */
const MOD_THEMES = themeModFiles()

const PARTS = ['background', 'primary', 'foreground'] as const

/** The theme shown with the flavour and accent it falls back to. */
const fallbackState = (theme: ThemeDefinition, dark: boolean): ThemeState => ({
  theme: theme.id,
  dark,
  flavour: theme.flavours?.fallback ?? null,
  accent: theme.accents?.fallback ?? null,
})

describe('theme tokens', () => {
  it('defines every default token for both schemes', () => {
    expect(tokens.length).toBeGreaterThan(0)
    expect(sorted(defaults.get('.dark'))).toEqual(colours)
  })

  it('backs every Tailwind colour with a token', () => {
    const app = read('../../App.css')
    const used = [...app.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map((m) => m[1] ?? '')
    expect(used.filter((name) => !tokens.includes(name))).toEqual([])
  })

  it('finds the themes the mods in mods/ add', () => {
    expect(MOD_THEMES.length).toBeGreaterThan(0)
  })

  it.each(MOD_THEMES)('$definition.id defines every token in each of its schemes', ({ definition, css }) => {
    const own = blocks(css)
    const light = `:root[data-theme='${definition.id}']`
    for (const scheme of definition.schemes) {
      const selector = scheme === 'dark' && definition.schemes.length > 1 ? `${light}.dark` : light
      const defined = sorted(own.get(selector)).filter((name) => colours.includes(name))
      expect(defined, `${definition.id} ${scheme}`).toEqual(colours)
    }
  })

  it.each(MOD_THEMES)('$definition.id sets tokens only while it is the theme shown', ({ definition, css }) => {
    for (const rule of rules(css)) {
      for (const selector of rule.selector.split(',')) {
        expect(selector.trim().startsWith(`:root[data-theme='${definition.id}']`), selector).toBe(true)
      }
    }
    for (const dark of [false, true]) {
      expect(cascade(css, { theme: DEFAULT_THEME, dark, flavour: null, accent: null }).size).toBe(0)
    }
  })
})

describe('theme swatches', () => {
  it('show the default colours of each scheme', () => {
    const swatches = rules(read('themes/swatches.css'))
    const source = rules(defaultCss)
    for (const selector of [':root', '.dark']) {
      const shown = new Map(swatches.find((rule) => rule.selector === selector)?.declarations)
      const own = new Map(source.find((rule) => rule.selector === selector)?.declarations)
      for (const part of PARTS) {
        expect(shown.get(`--swatch-default-${part}`), `${selector} ${part}`).toBe(own.get(`--${part}`))
      }
    }
  })

  it.each(MOD_THEMES)('$definition.id shows its own colours in the swatch of each scheme', ({ definition, css }) => {
    for (const scheme of definition.schemes) {
      const values = cascade(css, fallbackState(definition, scheme === 'dark'))
      for (const part of PARTS) {
        const shown = definition.swatch[scheme]?.[part].toLowerCase()
        expect(shown, `${scheme} ${part}`).toBe(resolve(values, `var(--${part})`).toLowerCase())
      }
    }
  })

  it.each(MOD_THEMES)('$definition.id swatches each option with a colour it shows', ({ definition, css }) => {
    for (const option of definition.flavours?.options ?? []) {
      const values = cascade(css, { ...fallbackState(definition, true), flavour: option.id })
      expect(option.swatch.toLowerCase(), option.id).toBe(resolve(values, 'var(--background)').toLowerCase())
    }
    for (const option of definition.accents?.options ?? []) {
      const values = cascade(css, { ...fallbackState(definition, false), accent: option.id })
      expect(() => resolve(values, option.swatch), option.id).not.toThrow()
    }
  })
})

describe('applyTheme', () => {
  const root = () => {
    const attributes = new Map<string, string>()
    const classes = new Set<string>(['light'])
    return {
      attributes,
      classes,
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value)
      },
      removeAttribute: (name: string) => {
        attributes.delete(name)
      },
      classList: {
        add: (...names: string[]) => {
          for (const name of names) {
            classes.add(name)
          }
        },
        remove: (...names: string[]) => {
          for (const name of names) {
            classes.delete(name)
          }
        },
      },
    }
  }

  it('sets the theme, flavour, accent and scheme', () => {
    const html = root()
    applyTheme(html, { themeId: 'sample.pastel', scheme: 'dark', flavour: 'frappe', accent: 'teal' })
    expect(Object.fromEntries(html.attributes)).toEqual({
      'data-theme': 'sample.pastel',
      'data-flavour': 'frappe',
      'data-accent': 'teal',
    })
    expect([...html.classes]).toEqual(['dark'])
  })

  it('drops the flavour and accent for a theme without them', () => {
    const html = root()
    applyTheme(html, { themeId: 'sample.pastel', scheme: 'light', flavour: 'mocha', accent: 'pink' })
    applyTheme(html, { themeId: 'default', scheme: 'light', flavour: null, accent: null })
    expect(Object.fromEntries(html.attributes)).toEqual({ 'data-theme': 'default' })
    expect([...html.classes]).toEqual(['light'])
  })
})

const TEXT = [
  ['--foreground', '--background'],
  ['--foreground', '--card'],
  ['--foreground', '--muted'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--muted'],
  ['--primary', '--background'],
  ['--primary', '--card'],
  ['--primary', '--muted'],
  ['--primary-foreground', '--primary'],
  ['--warning-text', '--background'],
  ['--warning-text', '--card'],
  ['--warning-text', '--muted'],
] as const

/** Marks that carry state without text: the shell border, warning marks and focus rings. */
const NON_TEXT = [
  ['--shell', '--background'],
  ['--warning', '--background'],
  ['--ring', '--background'],
] as const

interface Case {
  label: string
  css: string
  state: ThemeState
}

/** Each scheme of a mod's theme, with every dark flavour and every accent it offers. */
function casesOf({ definition, css }: ThemeModFile): Case[] {
  const accents = definition.accents?.options.map((option) => option.id) ?? [null]
  const flavours = definition.flavours?.options.map((option) => option.id) ?? [null]
  return definition.schemes.flatMap((scheme) => {
    const dark = scheme === 'dark'
    const inScheme = dark ? flavours : [definition.flavours?.fallback ?? null]
    return inScheme.flatMap((flavour) =>
      accents.map((accent) => ({
        label: [definition.id, scheme, dark ? flavour : null, accent].filter((part) => part !== null).join(' '),
        css,
        state: { theme: definition.id, dark, flavour, accent },
      })),
    )
  })
}

const CASES: Case[] = [
  ...[false, true].map((dark) => ({
    label: `default ${dark ? 'dark' : 'light'}`,
    css: defaultCss,
    state: { theme: DEFAULT_THEME, dark, flavour: null, accent: null },
  })),
  ...MOD_THEMES.flatMap(casesOf),
]

describe('contrast', () => {
  it.each(CASES)('$label passes AA: 4.5 for text, 3 for marks', ({ css, state }) => {
    const values = cascade(css, state)
    const colour = (token: string) => srgbOf(resolve(values, `var(${token})`))
    const failing = [
      ...TEXT.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(colour(fg), colour(bg)), need: 4.5 })),
      ...NON_TEXT.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(colour(fg), colour(bg)), need: 3 })),
    ]
      .filter(({ ratio, need }) => ratio < need)
      .map(({ pair, ratio }) => `${pair} ${ratio.toFixed(2)}`)
    expect(failing).toEqual([])
  })
})

/** Surfaces an agent's stripe sits on: rows, selected rows, cards, menus and its own tint. */
const STRIPE_ON = ['background', 'accent', 'card', 'popover'] as const
const ON_TINT = ['foreground', 'mutedForeground', 'primary', 'warningText'] as const
/** Status colours a stripe can sit beside, which it must not be mistaken for. */
const STATUSES = ['destructive', 'warning', 'warningText'] as const

/** A sweep round the wheel at three strengths, the presets, and inputs at the edges. */
const SWEEP = [
  ...Array.from({ length: 24 }, (_, i) => i * 15).flatMap((h) =>
    [
      [0.66, 0.17],
      [0.42, 0.12],
      [0.9, 0.08],
    ].map(([l = 0, c = 0]) => hexOf(fromOklch(l, c, h))),
  ),
  ...AGENT_COLOR_PRESETS.map((preset) => preset.hex),
  '#000000',
  '#ffffff',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
  '#fef9c3',
  '#808a8c',
  '#7f7f7f',
]

function agentInkFailures(ink: ThemeInk, color: string): string[] {
  const { stripe: stripeHex, tint: tintHex } = deriveAgentColor(color, ink)
  const [stripe, tint] = [rgbOf(stripeHex), rgbOf(tintHex)]
  const input = lchOf(rgbOf(color))
  const [shown, wash] = [lchOf(stripe), lchOf(tint)]
  const checks = [
    ...[...STRIPE_ON.map((name) => [name, ink[name]] as const), ['tint', tint] as const].map(([name, surface]) => ({
      what: `stripe on ${name}`,
      value: contrast(stripe, surface),
      need: STRIPE_CONTRAST,
    })),
    ...ON_TINT.map((name) => ({ what: `${name} on tint`, value: contrast(ink[name], tint), need: TINT_TEXT_CONTRAST })),
    ...STATUSES.map((name) => ({
      what: `stripe from ${name}`,
      value: labDistance(stripe, ink[name]),
      need: STATUS_DISTANCE,
    })),
  ]
  if (input.c < NEUTRAL_CHROMA) {
    checks.push(
      { what: 'neutral stripe', value: -shown.c, need: -0.005 },
      { what: 'neutral tint', value: -wash.c, need: -0.005 },
    )
  } else if (shown.c > 0.04) {
    checks.push({ what: 'hue kept', value: -hueGap(shown.h, input.h), need: -4 })
  }
  return checks
    .filter(({ value, need }) => value < need)
    .map(({ what, value }) => `${color} ${what} ${value.toFixed(3)}`)
}

/** The default theme tokens the first seven colours shipped with; those agents stay close. */
const SHIPPED = {
  light: {
    green: 'oklch(0.55 0.14 150)',
    teal: 'oklch(0.55 0.1 190)',
    sky: 'oklch(0.56 0.12 232)',
    blue: 'oklch(0.52 0.17 262)',
    indigo: 'oklch(0.5 0.17 285)',
    violet: 'oklch(0.52 0.19 312)',
    pink: 'oklch(0.56 0.19 352)',
  },
  dark: {
    green: 'oklch(0.74 0.15 150)',
    teal: 'oklch(0.74 0.11 190)',
    sky: 'oklch(0.74 0.12 232)',
    blue: 'oklch(0.7 0.15 262)',
    indigo: 'oklch(0.7 0.14 285)',
    violet: 'oklch(0.72 0.16 312)',
    pink: 'oklch(0.74 0.16 352)',
  },
}

describe('agent colours', () => {
  it.each(CASES)('$label fits every hue and edge input with stripes at 3:1, tints at AA, off status', (theme) => {
    const values = cascade(theme.css, theme.state)
    const ink = themeInk((token) => srgbOf(resolve(values, `var(${token})`)))
    expect(SWEEP.flatMap((color) => agentInkFailures(ink, color)).slice(0, 20)).toEqual([])
  })

  it.each([
    ['light', false],
    ['dark', true],
  ] as const)('keeps the shipped %s stripes of the first seven presets', (scheme, dark) => {
    const values = cascade(defaultCss, { theme: 'default', dark, flavour: null, accent: null })
    const ink = themeInk((token) => srgbOf(resolve(values, `var(${token})`)))
    for (const [name, shipped] of Object.entries(SHIPPED[scheme])) {
      const hex = AGENT_COLOR_PRESETS.find((preset) => preset.name === name)?.hex ?? ''
      const { stripe } = deriveAgentColor(hex, ink)
      expect(labDistance(rgbOf(stripe), srgbOf(shipped)), `${scheme} ${name}`).toBeLessThan(0.06)
    }
  })
})

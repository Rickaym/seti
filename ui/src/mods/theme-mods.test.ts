import { flavors } from '@catppuccin/palette'
import { describe, expect, it } from 'vitest'
import { cascade, resolve, srgbOf, hueGap } from '@/components/theme/theme-cascade'
import { contrast, labDistance, oklch } from '@/lib/agent-color'
import { colourTokens, themeModFiles } from './theme-mod-files'

const themeFile = (id: string) => {
  const file = themeModFiles().find((entry) => entry.definition.id === id)
  if (file === undefined) {
    throw new Error(`no mod adds the theme ${id}`)
  }
  return file
}

const colours = colourTokens()

const CATPPUCCIN = 'catppuccin.catppuccin'
const { css: catppuccinCss, definition: catppuccin } = themeFile(CATPPUCCIN)
const flavourIds = catppuccin.flavours?.options.map((option) => option.id) ?? []
const accentIds = catppuccin.accents?.options.map((option) => option.id) ?? []

type FlavourName = keyof typeof flavors
const isFlavour = (id: string): id is FlavourName => id in flavors
const paletteOf = (id: string) => {
  if (!isFlavour(id)) {
    throw new Error(`no Catppuccin flavour ${id}`)
  }
  return flavors[id].colors
}

const shadeOf = (palette: string, name: string) =>
  Object.entries(paletteOf(palette)).find(([shade]) => shade === name)?.[1].hex ?? ''

const SCHEMES = flavourIds.flatMap((flavour) => [
  { label: `latte (${flavour} chosen)`, palette: 'latte', state: { dark: false, flavour } },
  { label: flavour, palette: flavour, state: { dark: true, flavour } },
])

describe('catppuccin', () => {
  it('offers the three dark flavours and the fourteen accents', () => {
    expect(flavourIds).toEqual(['frappe', 'macchiato', 'mocha'])
    expect(accentIds).toEqual([
      'rosewater',
      'flamingo',
      'pink',
      'mauve',
      'red',
      'maroon',
      'peach',
      'yellow',
      'green',
      'teal',
      'sky',
      'sapphire',
      'blue',
      'lavender',
    ])
    expect(catppuccin.flavours?.fallback).toBe('mocha')
    expect(catppuccin.accents?.fallback).toBe('mauve')
  })

  it.each(SCHEMES)('$label holds the official palette', ({ palette, state }) => {
    const values = cascade(catppuccinCss, { theme: CATPPUCCIN, accent: null, ...state })
    for (const [name, colour] of Object.entries(paletteOf(palette))) {
      expect(values.get(`--ctp-${name}`), `${palette} ${name}`).toBe(colour.hex)
    }
  })

  it.each(SCHEMES)('$label defines every token from its palette and its deep accents', ({ palette, state }) => {
    const values = cascade(catppuccinCss, { theme: CATPPUCCIN, accent: null, ...state })
    const deep = state.dark ? [] : accentIds.map((accent) => values.get(`--ctp-${accent}-deep`) ?? '')
    const allowed = new Set([...Object.values(paletteOf(palette)).map((colour) => colour.hex), ...deep])
    for (const token of colours) {
      const raw = values.get(token)
      expect(raw, token).toBeDefined()
      const value = resolve(values, raw ?? '')
      expect(value, token).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/)
      for (const hex of value.match(/#[\da-f]{3,8}\b/gi) ?? []) {
        expect(allowed.has(hex), `${token} uses ${hex}, not in ${palette}`).toBe(true)
      }
    }
  })

  it('darkens each Latte accent in OKLCH and keeps its hue', () => {
    const values = cascade(catppuccinCss, { theme: CATPPUCCIN, accent: null, dark: false, flavour: 'mocha' })
    for (const accent of accentIds) {
      const shade = shadeOf('latte', accent)
      const [light, deep] = [oklch(srgbOf(shade)), oklch(srgbOf(values.get(`--ctp-${accent}-deep`) ?? ''))]
      expect(deep.l, accent).toBeLessThan(light.l)
      expect(Math.abs(((deep.h - light.h + 540) % 360) - 180), accent).toBeLessThan(4)
    }
  })

  it.each(SCHEMES)('$label applies every accent to primary and ring', ({ palette, state }) => {
    for (const accent of accentIds) {
      const values = cascade(catppuccinCss, { theme: CATPPUCCIN, accent, ...state })
      const expected = state.dark ? shadeOf(palette, accent) : values.get(`--ctp-${accent}-deep`)
      expect(resolve(values, 'var(--primary)'), accent).toBe(expected)
      expect(resolve(values, 'var(--ring)'), accent).toBe(expected)
    }
  })

  it.each(SCHEMES)('$label writes on accents in the more legible of base and text', ({ palette, state }) => {
    const shades = paletteOf(palette)
    for (const accent of accentIds) {
      const values = cascade(catppuccinCss, { theme: CATPPUCCIN, accent, ...state })
      const fill = srgbOf(resolve(values, 'var(--primary)'))
      const ink = srgbOf(resolve(values, 'var(--primary-foreground)'))
      const best = Math.max(contrast(fill, srgbOf(shades.base.hex)), contrast(fill, srgbOf(shades.text.hex)))
      expect(contrast(fill, ink), `${palette} ${accent}`).toBeCloseTo(best, 5)
    }
  })
})

describe('claude', () => {
  const claudeCss = themeFile('claude-theme.claude').css
  const valuesOf = (dark: boolean) =>
    cascade(claudeCss, { theme: 'claude-theme.claude', dark, flavour: null, accent: null })
  const colourIn = (values: Map<string, string>, token: string) => srgbOf(resolve(values, `var(${token})`))

  it.each([false, true])('dark=%s draws every token from its own palette', (dark) => {
    const values = valuesOf(dark)
    const palette = new Set(
      [...values].filter(([name]) => name.startsWith('--claude-')).map(([, value]) => value.toLowerCase()),
    )
    for (const token of colours) {
      const value = resolve(values, values.get(token) ?? '')
      expect(value, token).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/)
      for (const hex of value.match(/#[\da-f]{3,8}\b/gi) ?? []) {
        expect(palette.has(hex.toLowerCase()), `${token} uses ${hex}`).toBe(true)
      }
    }
  })

  it('uses the Claude orange when dark and the same hue darkened for text when light', () => {
    const orange = oklch(srgbOf('#d97757'))
    expect(resolve(valuesOf(true), 'var(--primary)')).toBe('#d97757')
    const light = oklch(colourIn(valuesOf(false), '--primary'))
    expect(light.l).toBeLessThan(orange.l)
    expect(hueGap(light.h, orange.h)).toBeLessThan(4)
  })

  it.each([false, true])('dark=%s keeps destructive apart from the orange primary', (dark) => {
    const values = valuesOf(dark)
    const [primary, destructive] = [colourIn(values, '--primary'), colourIn(values, '--destructive')]
    expect(labDistance(primary, destructive)).toBeGreaterThan(0.08)
    expect(hueGap(oklch(primary).h, oklch(destructive).h)).toBeGreaterThan(18)
  })
})

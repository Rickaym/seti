import {
  AGENT_COLOR_PRESETS,
  agentColorFromWords,
  agentColorInput,
  agentColorWord,
  normalizeAgentColor,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  agentColorLabel,
  contrast,
  deriveAgentColor,
  oklch,
  PRESET_SWATCHES,
  rgbOf,
  type Rgb,
  type ThemeInk,
} from '@/lib/agent-color'

describe('normalizeAgentColor', () => {
  it('takes #rgb and #rrggbb in any case and preset names, and stores #rrggbb', () => {
    expect(normalizeAgentColor('#3B82F6')).toBe('#3b82f6')
    expect(normalizeAgentColor(' #f0a ')).toBe('#ff00aa')
    expect(normalizeAgentColor('Teal')).toBe('#3baca6')
  })

  it('refuses anything else', () => {
    for (const value of ['', '#', '3b82f6', '#12', '#1234', '#12345', '#1234567', '#ggg', 'purple', 'rgb(0,0,0)']) {
      expect(normalizeAgentColor(value), value).toBeNull()
    }
  })

  it('maps everyday names to presets only where a tool asks for it', () => {
    expect(agentColorFromWords('Purple')).toBe('#b066da')
    expect(agentColorFromWords('light   blue')).toBe('#37a4d5')
    expect(agentColorFromWords('#abc')).toBe('#aabbcc')
    expect(agentColorFromWords('sunset')).toBeNull()
    expect(agentColorInput.safeParse('purple').success).toBe(false)
    expect(agentColorInput.parse('#ABC')).toBe('#aabbcc')
  })

  it('names presets by name and other colours by hex', () => {
    expect(agentColorWord('#3baca6')).toBe('teal')
    expect(agentColorWord('#123456')).toBe('#123456')
    expect(agentColorWord(null)).toBe('')
    expect(agentColorLabel('#e05b9e')).toBe('Pink')
    expect(agentColorLabel('#123456')).toBe('#123456')
  })
})

describe('presets', () => {
  it('offers fourteen distinct colours round the wheel, each a stored hex', () => {
    expect(PRESET_SWATCHES).toHaveLength(14)
    expect(new Set(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).size).toBe(14)
    const hues = AGENT_COLOR_PRESETS.map((preset) => oklch(rgbOf(preset.hex)).h).toSorted((a, b) => a - b)
    const gaps = hues.map((hue, i) => (i === 0 ? hue + 360 - (hues.at(-1) ?? 0) : hue - (hues[i - 1] ?? 0)))
    expect(Math.min(...gaps)).toBeGreaterThan(15)
    expect(Math.max(...gaps)).toBeLessThan(45)
    for (const preset of AGENT_COLOR_PRESETS) {
      expect(normalizeAgentColor(preset.hex)).toBe(preset.hex)
    }
  })
})

const grey = (v: number): Rgb => [v, v, v]

/** A plain white theme and a near-black one, to check the derivation away from the real themes. */
const PLAIN: Record<'light' | 'dark', ThemeInk> = {
  light: {
    background: grey(1),
    card: grey(1),
    popover: grey(1),
    accent: grey(0.96),
    foreground: grey(0.05),
    mutedForeground: grey(0.45),
    primary: grey(0.1),
    warningText: rgbOf('#a16207'),
    warning: rgbOf('#f59e0b'),
    destructive: rgbOf('#dc2626'),
  },
  dark: {
    background: grey(0.04),
    card: grey(0.07),
    popover: grey(0.07),
    accent: grey(0.15),
    foreground: grey(0.98),
    mutedForeground: grey(0.64),
    primary: grey(0.95),
    warningText: rgbOf('#facc15'),
    warning: rgbOf('#eab308'),
    destructive: rgbOf('#f87171'),
  },
}

describe('deriveAgentColor', () => {
  it.each(['light', 'dark'] as const)('keeps a stripe at 3:1 and its hue on a plain %s theme', (scheme) => {
    const ink = PLAIN[scheme]
    for (const color of ['#3b82f6', '#ff0000', '#fef9c3', '#000000', '#ffffff']) {
      const { stripe, tint } = deriveAgentColor(color, ink)
      expect(contrast(rgbOf(stripe), ink.background), color).toBeGreaterThanOrEqual(3)
      expect(contrast(ink.mutedForeground, rgbOf(tint)), color).toBeGreaterThanOrEqual(4.5)
    }
    const blue = oklch(rgbOf(deriveAgentColor('#3b82f6', ink).stripe))
    expect(Math.abs(blue.h - oklch(rgbOf('#3b82f6')).h)).toBeLessThan(3)
  })

  it('places darker inputs lower in the band, so navy stays darker than sky in both schemes', () => {
    for (const ink of Object.values(PLAIN)) {
      const [navy, sky] = ['#1e3a8a', '#7dd3fc'].map((color) => oklch(rgbOf(deriveAgentColor(color, ink).stripe)).l)
      expect(navy).toBeLessThan(sky ?? 0)
    }
  })

  it('gives greys and near greys a neutral stripe and tint', () => {
    for (const color of ['#808a8c', '#7f7f7f', '#000000', '#ffffff']) {
      const { stripe, tint } = deriveAgentColor(color, PLAIN.light)
      expect(oklch(rgbOf(stripe)).c, color).toBeLessThan(0.005)
      expect(oklch(rgbOf(tint)).c, color).toBeLessThan(0.005)
    }
  })

  it('moves a red stripe away from the error red it can sit beside', () => {
    const { stripe } = deriveAgentColor('#dc2626', PLAIN.light)
    expect(stripe).not.toBe('#dc2626')
    expect(oklch(rgbOf(stripe)).h).toBeCloseTo(oklch(rgbOf('#dc2626')).h, -1)
  })
})

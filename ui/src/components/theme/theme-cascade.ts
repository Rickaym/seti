import type { Rgb } from '@/lib/agent-color'

/** What <html> carries, for working out which token rules of a stylesheet apply. */
export interface ThemeState {
  theme: string
  dark: boolean
  flavour: string | null
  accent: string | null
}

interface Rule {
  selector: string
  declarations: Map<string, string>
}

/** The rules of a flat stylesheet in source order, with their custom properties. */
export function rules(css: string): Rule[] {
  const found: Rule[] = []
  for (const rule of css.replaceAll(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const [selector = '', body = ''] = rule.split('{')
    const declarations = new Map<string, string>()
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      const name = declaration.slice(0, colon).trim()
      if (colon > 0 && name.startsWith('--')) {
        declarations.set(name, declaration.slice(colon + 1).trim())
      }
    }
    if (declarations.size > 0) {
      found.push({ selector: selector.trim(), declarations })
    }
  }
  return found
}

export function blocks(css: string): Map<string, Set<string>> {
  return new Map(rules(css).map((rule) => [rule.selector, new Set(rule.declarations.keys())]))
}

const CONDITION = /:root|:not\(\.dark\)|\.dark|\[data-(theme|flavour|accent)='([\w.-]+)'\]/g

function holds(state: ThemeState, [whole, key, value]: RegExpMatchArray): boolean {
  switch (whole) {
    case ':root': {
      return true
    }
    case '.dark': {
      return state.dark
    }
    case ':not(.dark)': {
      return !state.dark
    }
    default: {
      const attributes = new Map([
        ['theme', state.theme],
        ['flavour', state.flavour],
        ['accent', state.accent],
      ])
      return value !== undefined && attributes.get(key ?? '') === value
    }
  }
}

/** The specificity of a selector that matches the state, or null when it does not. */
function specificity(selector: string, state: ThemeState): number | null {
  const parts = [...selector.matchAll(CONDITION)]
  if (parts.map((part) => part[0]).join('') !== selector) {
    throw new Error(`cannot read the selector ${selector}`)
  }
  return parts.every((part) => holds(state, part)) ? parts.length : null
}

/** The custom properties <html> ends up with for the state, after the cascade. */
export function cascade(css: string, state: ThemeState): Map<string, string> {
  const applied = rules(css).flatMap((rule, order) =>
    rule.selector.split(',').flatMap((selector) => {
      const weight = specificity(selector.trim(), state)
      return weight === null ? [] : [{ weight, order, rule }]
    }),
  )
  applied.sort((a, b) => (a.weight === b.weight ? a.order - b.order : a.weight - b.weight))
  return new Map(applied.flatMap(({ rule }) => [...rule.declarations]))
}

/** The value with every var() replaced by what it holds; throws on one that is not defined. */
export function resolve(values: Map<string, string>, value: string, depth = 0): string {
  if (depth >= 10) {
    throw new Error(`${value} refers to itself`)
  }
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const inner = values.get(name)
    if (inner === undefined) {
      throw new Error(`${name} is not defined`)
    }
    return resolve(values, inner, depth + 1)
  })
}

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp = (c: number) => Math.min(1, Math.max(0, c))

export function fromOklch(l: number, c: number, h: number): Rgb {
  const [a, b] = [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3)
  const [x = 0, y = 0, z = 0] = lms
  const linear = [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ]
  const [r = 0, g = 0, bl = 0] = linear.map((v) => toGamma(clamp(v)))
  return [r, g, bl]
}

/** Splits at the commas outside any parentheses. */
function args(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
    } else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  return [...parts, inner.slice(start).trim()]
}

/** A resolved token value as gamma-encoded sRGB: hex, oklch() or color-mix(in srgb, ...). */
export function srgbOf(value: string): Rgb {
  const text = value.trim()
  if (text.startsWith('#')) {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(text.slice(i, i + 2), 16) / 255)
    return [r, g, b]
  }
  const lch = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/.exec(text)
  if (lch !== null) {
    const [, l = '0', percent, c = '0', h = '0'] = lch
    return fromOklch(Number(l) / (percent === '%' ? 100 : 1), Number(c), Number(h))
  }
  const mix = /^color-mix\(in srgb, (.+)\)$/.exec(text)
  if (mix !== null) {
    return mixed(mix[1] ?? '')
  }
  throw new Error(`cannot read the colour ${text}`)
}

/** The arguments of color-mix(in srgb, a p%, b), blended in gamma-encoded sRGB as CSS does. */
function mixed(inner: string): Rgb {
  const [first = '', second = ''] = args(inner)
  const share = /\s(\d+(?:\.\d+)?)%$/.exec(first)
  const weight = share === null ? 0.5 : Number(share[1]) / 100
  const colourOf = (part: string) => srgbOf(part.replace(/\s\d+(?:\.\d+)?%$/, ''))
  const [a, b] = [colourOf(first), colourOf(second)]
  const blend = (i: 0 | 1 | 2) => a[i] * weight + b[i] * (1 - weight)
  return [blend(0), blend(1), blend(2)]
}

export const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

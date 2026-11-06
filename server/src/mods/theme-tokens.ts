import { Registry, type Disposer, type ModManifest, type ModTheme } from '@seti/shared'
import { modVersions } from '../store/mod-packages.js'

/** The token CSS of a running third-party mod's themes, rebuilt from what Seti checked. */
interface ThemeTokens {
  mod: string
  css: string
}

export const modThemeTokens = new Registry<ThemeTokens>('theme tokens', (entry) => entry.mod)

const THEME_TOKEN_LIMITS = { declarations: 2000, name: 60 } as const

const ATOM = String.raw`#[0-9a-f]{3,8}|var\(--[a-z0-9-]{1,60}\)|transparent|(?:rgba?|hsla?|oklch|oklab)\([0-9.%\s,/+-]{1,80}\)`
const MIX_PART = String.raw`(?:${ATOM})(?: [0-9.]{1,6}%)?`
const MIX = String.raw`color-mix\(in (?:srgb|oklch|oklab|hsl), ${MIX_PART}, ${MIX_PART}\)`
const COLOUR = new RegExp(String.raw`^(?:${ATOM}|${MIX})$`, 'i')
const LENGTH = /^(?:0|\d{1,3}(?:\.\d{1,3})?(?:rem|px))$/
const NAME = /^--[a-z][a-z0-9-]{0,58}$/
const OPTION = String.raw`\[data-(?:flavour|accent)='[a-z0-9][a-z0-9-]{0,39}'\]`

/** The selectors a theme may set tokens under: its own data-theme, with a scheme and options. */
function selectorPattern(mod: string, theme: string): RegExp {
  return new RegExp(String.raw`^:root\[data-theme='${mod}\.${theme}'\](?:\.dark|:not\(\.dark\))?(?:${OPTION}){0,2}$`)
}

/** A value Seti lets a theme give: a colour, or a plain length for a radius token. */
const valueOk = (name: string, value: string) => COLOUR.test(value) || (name.includes('radius') && LENGTH.test(value))

interface Rule {
  selector: string
  declarations: [string, string][]
}

/** Reads `selector { --name: value; ... }` rules and nothing else; null on anything other. */
function parseRules(css: string): Rule[] | null {
  const text = css.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const parts = text.split('}')
  if ((parts.at(-1) ?? '').trim() !== '') {
    return null
  }
  const rules: Rule[] = []
  for (const part of parts.slice(0, -1)) {
    const [selector = '', body, extra] = part.split('{')
    if (body === undefined || extra !== undefined) {
      return null
    }
    const declarations = body
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry): [string, string] => {
        const colon = entry.indexOf(':')
        return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
      })
    rules.push({ selector: selector.trim(), declarations })
  }
  return rules
}

/**
 * The theme's token CSS rebuilt from the declarations Seti checked, or why it is refused. Only
 * custom properties under the theme's own selectors with colour values pass, so a theme can
 * recolour Seti but never load a URL, hide an element or style anything by itself.
 */
export function themeTokensCss(mod: string, theme: ModTheme, css: string): { css: string } | { problem: string } {
  const refuse = (why: string) => ({ problem: `${theme.tokens}: ${why}` })
  const rules = parseRules(css)
  if (rules === null) {
    return refuse('holds something other than rules of custom properties')
  }
  const selector = selectorPattern(mod, theme.id)
  const out: string[] = []
  let count = 0
  for (const rule of rules) {
    if (!selector.test(rule.selector)) {
      return refuse(`${rule.selector.slice(0, 80)} is not a selector of the theme ${mod}.${theme.id}`)
    }
    const lines: string[] = []
    for (const [name, value] of rule.declarations) {
      if (!NAME.test(name) || !valueOk(name, value)) {
        return refuse(`${name.slice(0, 60)} is not a custom property with a colour value`)
      }
      lines.push(`  ${name}: ${value};`)
    }
    count += lines.length
    out.push(`${rule.selector} {\n${lines.join('\n')}\n}`)
  }
  if (count > THEME_TOKEN_LIMITS.declarations) {
    return refuse(`has over ${String(THEME_TOKEN_LIMITS.declarations)} declarations`)
  }
  return { css: out.join('\n') }
}

/** Offers the checked token CSS of the pinned version while the mod runs. */
export async function serveThemes(manifest: ModManifest, hash: string, track: (dispose: Disposer) => Disposer) {
  if (manifest.contributes.themes.length === 0) {
    return
  }
  const version = await modVersions.get(manifest.id, hash)
  const parts = manifest.contributes.themes.map((theme) => {
    const checked = themeTokensCss(manifest.id, theme, version?.files.get(theme.tokens)?.toString('utf8') ?? '')
    return 'css' in checked ? checked.css : ''
  })
  track(modThemeTokens.register({ mod: manifest.id, css: parts.join('\n') }))
}

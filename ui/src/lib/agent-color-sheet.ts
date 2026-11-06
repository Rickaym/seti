import type { AgentColor } from '@seti/shared'
import { deriveAgentColor, THEME_INK_TOKENS, themeInk, type ThemeInk } from './agent-color'
import { readTokens } from './theme-tokens'

const fitted = new Set<AgentColor>()
let ink: ThemeInk | null = null
let sheet: HTMLStyleElement | null = null

/** The active theme's colours. */
function readTheme(): ThemeInk | null {
  const colours = readTokens(THEME_INK_TOKENS)
  return colours === null ? null : themeInk((token) => colours[token])
}

function rule(color: AgentColor, theme: ThemeInk): string {
  const { stripe, tint } = deriveAgentColor(color, theme)
  return `[data-agent-color='${color}'] { --agent-stripe: ${stripe}; --agent-tint: ${tint}; }\n`
}

function styleSheet(): HTMLStyleElement {
  if (sheet === null) {
    sheet = document.createElement('style')
    sheet.dataset.agentColors = ''
    document.head.append(sheet)
  }
  return sheet
}

function fit(color: AgentColor): void {
  if (fitted.has(color) || typeof document === 'undefined') {
    return
  }
  ink ??= readTheme()
  if (ink !== null) {
    fitted.add(color)
    styleSheet().append(rule(color, ink))
  }
}

/** Fits every colour in use to the theme now on <html>; the theme calls it after each change. */
export function refitAgentColors(): void {
  ink = readTheme()
  const theme = ink
  if (theme !== null && fitted.size > 0) {
    styleSheet().textContent = [...fitted].map((color) => rule(color, theme)).join('')
  }
}

/** An agent colour's stripe in the theme now on <html>, as `#rrggbb`, for drawing on a canvas. */
export function agentStripe(color: AgentColor): string | null {
  ink ??= readTheme()
  return ink === null ? null : deriveAgentColor(color, ink).stripe
}

/** Marks an element with an agent's colour, setting `--agent-stripe` and `--agent-tint` on it. */
export function agentColorAttr(color: AgentColor | null): { 'data-agent-color'?: AgentColor } {
  if (color === null) {
    return {}
  }
  fit(color)
  return { 'data-agent-color': color }
}

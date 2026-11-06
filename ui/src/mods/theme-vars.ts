import type { ModBridgeOut } from '@seti/shared'
import { blocks } from '@/components/theme/theme-cascade'
import defaultTokens from '@/components/theme/themes/default.css?raw'

type ThemeMessage = Extract<ModBridgeOut, { t: 'theme' }>

/** Every token Seti's themes define, as the theme registry checks each theme against. */
const TOKENS = [...(blocks(defaultTokens).get(':root') ?? [])]

const VALUE_MAX = 200
const MONO = 'ui-monospace, monospace'

/**
 * The current theme as a view gets it: each token's resolved value, light or dark, and the font
 * family names; a view cannot load Seti's fonts, so it falls back to the system's.
 */
export function themeMessage(): ThemeMessage {
  const root = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const token of TOKENS) {
    const value = root.getPropertyValue(token).trim()
    if (value !== '' && value.length <= VALUE_MAX) {
      vars[token] = value
    }
  }
  const mono = root.getPropertyValue('--font-mono').trim()
  return {
    t: 'theme',
    scheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    vars,
    font: {
      sans: getComputedStyle(document.body).fontFamily.slice(0, VALUE_MAX),
      mono: (mono === '' ? MONO : mono).slice(0, VALUE_MAX),
    },
  }
}

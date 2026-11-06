import type { AgentColor } from '@seti/shared'
import { hexOf } from '@/lib/agent-color'
import { agentStripe } from '@/lib/agent-color-sheet'
import { readTokens } from '@/lib/theme-tokens'

const TOKENS = [
  '--background',
  '--foreground',
  '--muted-foreground',
  '--border',
  '--card',
  '--accent',
  '--primary',
  '--warning',
  '--destructive',
  '--success',
] as const

/** The theme's colours as `#rrggbb`, which a canvas draws with. */
export interface GraphInk {
  background: string
  foreground: string
  muted: string
  border: string
  card: string
  accent: string
  primary: string
  warning: string
  destructive: string
  success: string
  /** An agent's stripe, or the muted colour for an agent without one. */
  agent: (color: AgentColor | null) => string
}

/** Reads the theme now on <html>; call it again after the theme changes. */
export function readGraphInk(): GraphInk | null {
  const tokens = readTokens(TOKENS)
  if (tokens === null) {
    return null
  }
  const muted = hexOf(tokens['--muted-foreground'])
  const stripes = new Map<AgentColor, string>()
  return {
    background: hexOf(tokens['--background']),
    foreground: hexOf(tokens['--foreground']),
    muted,
    border: hexOf(tokens['--border']),
    card: hexOf(tokens['--card']),
    accent: hexOf(tokens['--accent']),
    primary: hexOf(tokens['--primary']),
    warning: hexOf(tokens['--warning']),
    destructive: hexOf(tokens['--destructive']),
    success: hexOf(tokens['--success']),
    agent: (color) => {
      if (color === null) {
        return muted
      }
      const known = stripes.get(color)
      if (known !== undefined) {
        return known
      }
      const stripe = agentStripe(color) ?? muted
      stripes.set(color, stripe)
      return stripe
    },
  }
}

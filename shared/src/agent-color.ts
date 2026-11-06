import { z } from 'zod'

/** The swatches offered round the colour wheel; an agent can take any other hex as well. */
export const AGENT_COLOR_PRESETS = [
  { name: 'red', hex: '#e8605b' },
  { name: 'orange', hex: '#e77f3e' },
  { name: 'amber', hex: '#e4a339' },
  { name: 'yellow', hex: '#d4be52' },
  { name: 'lime', hex: '#95c352' },
  { name: 'green', hex: '#4eb068' },
  { name: 'teal', hex: '#3baca6' },
  { name: 'cyan', hex: '#30b1c4' },
  { name: 'sky', hex: '#37a4d5' },
  { name: 'blue', hex: '#5488ec' },
  { name: 'indigo', hex: '#7e74e1' },
  { name: 'violet', hex: '#b066da' },
  { name: 'magenta', hex: '#cb57be' },
  { name: 'pink', hex: '#e05b9e' },
] as const

/** An agent's colour as stored and sent: `#rrggbb` in lower case. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- names what a colour field holds
export type AgentColor = string

const STORED = /^#[\da-f]{6}$/
const TYPED = /^#(?:[\da-f]{3}|[\da-f]{6})$/

/** A preset name or a `#rgb` or `#rrggbb` hex, in any case, as `#rrggbb`; null when it is neither. */
export function normalizeAgentColor(value: string): AgentColor | null {
  const text = value.trim().toLowerCase()
  const preset = AGENT_COLOR_PRESETS.find((entry) => entry.name === text)
  if (preset !== undefined) {
    return preset.hex
  }
  if (!TYPED.test(text)) {
    return null
  }
  const digits = text.slice(1)
  return `#${digits.length === 3 ? digits.replaceAll(/./g, '$&$&') : digits}`
}

/** Everyday colour names, as people and models say them, and the preset each one means. */
export const AGENT_COLOR_ALIASES: Readonly<Record<string, string>> = {
  crimson: 'red',
  scarlet: 'red',
  maroon: 'red',
  coral: 'orange',
  peach: 'orange',
  gold: 'amber',
  mustard: 'yellow',
  chartreuse: 'lime',
  olive: 'lime',
  emerald: 'green',
  mint: 'green',
  turquoise: 'teal',
  aqua: 'cyan',
  azure: 'sky',
  'light blue': 'sky',
  navy: 'indigo',
  lavender: 'indigo',
  purple: 'violet',
  mauve: 'violet',
  fuchsia: 'magenta',
  rose: 'pink',
}

/** Like normalizeAgentColor, and an everyday name such as purple picks its preset. */
export function agentColorFromWords(value: string): AgentColor | null {
  const words = value.trim().toLowerCase().replaceAll(/\s+/g, ' ')
  return normalizeAgentColor(AGENT_COLOR_ALIASES[words] ?? words)
}

/** The preset a colour is, such as teal; null for any other hex. */
export const agentColorPreset = (color: AgentColor): string | null =>
  AGENT_COLOR_PRESETS.find((entry) => entry.hex === color)?.name ?? null

/** The words an agent's colour is found by: its preset name, or else its hex. */
export const agentColorWord = (color: AgentColor | null): string =>
  color === null ? '' : (agentColorPreset(color) ?? color)

export const storedAgentColor = z.string().regex(STORED)

/** What a request may send as a colour; the parsed value is always `#rrggbb`. */
export const agentColorInput = z.string().transform((value, ctx) => {
  const color = normalizeAgentColor(value)
  if (color === null) {
    ctx.addIssue({
      code: 'custom',
      message: `Expected a hex such as #3b82f6 or one of ${AGENT_COLOR_PRESETS.map((entry) => entry.name).join(', ')}`,
    })
    return z.NEVER
  }
  return color
})

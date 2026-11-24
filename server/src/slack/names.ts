import { shownSlackName } from '@seti/shared'
import type { SlackName } from '../store/slack-names.js'

const CHANNEL_ID = '[CG][A-Z0-9]{8,}'
const USER_ID = '[UW][A-Z0-9]{8,}'
const NAME_MAX = 80

/** Patterns that put a name beside an id in Slack markup and in the Slack MCP server's answers. */
const CHANNEL_PATTERNS = [
  new RegExp(`<#(${CHANNEL_ID})\\|([^>|]+)>`, 'g'),
  new RegExp(`#([\\w.-]+) \\((?:ID: )?(${CHANNEL_ID})\\)`, 'g'),
  new RegExp(`Name: #([\\w.-]+)\\n(?:[^\\n]*\\n){0,8}?[^\\n]*/archives/(${CHANNEL_ID})\\b`, 'g'),
]
const USER_PATTERNS = [
  new RegExp(`<@(${USER_ID})\\|([^>|]+)>`, 'g'),
  new RegExp(`^(?:From: )?([^\\n<>:]+?) <[^>\\s]+@[^>\\s]+> \\((?:ID: )?(${USER_ID})\\)`, 'gm'),
  new RegExp(`^Name: ([^\\n#]+)\\nUser ID: (${USER_ID})$`, 'gm'),
]

/** Patterns whose first group is the name and second the id; the markup ones are the other way. */
const NAME_FIRST = new Set([CHANNEL_PATTERNS[1], CHANNEL_PATTERNS[2], USER_PATTERNS[1], USER_PATTERNS[2]])

const clean = (name: string) => name.trim().replace(/^#/, '')

function found(text: string, patterns: readonly RegExp[], kind: SlackName['kind']): SlackName[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) => {
      const [first = '', second = ''] = match.slice(1)
      const [name, id] = NAME_FIRST.has(pattern) ? [first, second] : [second, first]
      const shown = clean(name)
      return shown === '' || shown.length > NAME_MAX ? [] : [{ id, kind, name: shown }]
    }),
  )
}

/** Every string in a tool result: the JSON's strings when it is JSON, else the text itself. */
function stringsOf(text: string): string[] {
  try {
    const strings: string[] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        strings.push(value)
      } else if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(walk)
      }
    }
    walk(JSON.parse(text))
    return strings
  } catch {
    return [text]
  }
}

/** The names a text shows beside Slack ids; the last sighting of an id wins. */
export function namesIn(text: string): SlackName[] {
  const byId = new Map<string, SlackName>()
  for (const part of stringsOf(text)) {
    for (const name of [...found(part, CHANNEL_PATTERNS, 'channel'), ...found(part, USER_PATTERNS, 'user')]) {
      byId.set(name.id, name)
    }
  }
  return [...byId.values()]
}

const MARKUP = /<([#@])([A-Z][A-Z0-9]{8,})(?:\|([^>]*))?>/g
const BARE_ID = /(?<![\w/=.#@-])[CGDUW][A-Z0-9]{8,11}\b/g

/** The Slack ids a text mentions, in markup or bare. */
export const idsIn = (text: string): string[] => [
  ...new Set([...[...text.matchAll(MARKUP)].map((m) => m[2] ?? ''), ...(text.match(BARE_ID) ?? [])]),
]

/** Slack markup and known bare ids replaced by names: `<#C1|x>` reads `#x`, `<@U1>` reads `@Dana`. */
export function readableSlack(text: string, names: ReadonlyMap<string, string>): string {
  const marked = text.replace(MARKUP, (whole, sign: string, id: string, label: string | undefined) => {
    const name = names.get(id) ?? (label === undefined || label === '' ? undefined : label)
    return name === undefined ? whole : `${sign}${name}`
  })
  return marked.replace(BARE_ID, (id) => shownSlackName(id, names) ?? id)
}

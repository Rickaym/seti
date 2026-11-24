import { shownSlackName } from '@seti/shared'

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

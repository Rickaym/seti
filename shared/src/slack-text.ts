import { shownSlackName, slackSendTarget } from './slack.js'

const MARKUP = /<([#@])([A-Z][A-Z0-9]{8,})(?:\|([^>]*))?>/g
const BARE_ID = /(?<![\w/=.#@-])[CGDUW][A-Z0-9]{8,11}\b/g
const SLACK_ID = /^[CGDUW][A-Z0-9]{8,}$/
const ID_FIELDS = new Set(['channel_id', 'channel', 'user_id', 'user'])

/** The Slack ids a text mentions, in markup or bare. */
export const idsIn = (text: string): string[] => [
  ...new Set([...[...text.matchAll(MARKUP)].map((m) => m[2] ?? ''), ...(text.match(BARE_ID) ?? [])]),
]

/**
 * Slack markup and known bare ids replaced by names: `<#C1|x>` reads `#x`, `<@U1>` reads `@Dana`.
 * Without `labels`, a label inside markup is never shown in place of a name Seti does not know.
 */
export function readableSlack(text: string, names: ReadonlyMap<string, string>, labels = true): string {
  const marked = text.replace(MARKUP, (whole, sign: string, id: string, label: string | undefined) => {
    const given = labels && label !== undefined && label !== '' ? label : undefined
    const name = names.get(id) ?? given
    return name === undefined ? whole : `${sign}${name}`
  })
  return marked.replace(BARE_ID, (id) => shownSlackName(id, names) ?? id)
}

/** What a field of a Slack call holding an id reads as, and whether Seti knows the name. */
export interface SlackFieldNote {
  text: string
  tone: 'name' | 'unknown' | 'invalid'
}

/**
 * The name for a Slack call's `channel_id`, `channel`, `user_id` or `user` field: `#deploys`, or
 * `DM to Dana` for a send to a person; null for any other field or call, or an empty value.
 */
export function slackFieldNote(
  tool: string,
  key: string,
  value: string,
  names: ReadonlyMap<string, string>,
): SlackFieldNote | null {
  const id = value.trim()
  if (!/slack/i.test(tool) || !ID_FIELDS.has(key) || id === '') {
    return null
  }
  if (!SLACK_ID.test(id)) {
    return { text: 'Not a Slack id', tone: 'invalid' }
  }
  const shown = shownSlackName(id, names)
  if (shown === null) {
    return { text: 'Name not known', tone: 'unknown' }
  }
  const send = slackSendTarget(tool, { [key]: id }) !== null
  const direct = /^[UWD]/.test(id) && send
  return { text: direct ? `DM to ${shown}` : shown, tone: 'name' }
}

/** The channels and people a message mentions, by name where Seti knows it, else by id. */
export const slackMentions = (text: string, names: ReadonlyMap<string, string>): string[] =>
  idsIn(text).map((id) => shownSlackName(id, names) ?? id)

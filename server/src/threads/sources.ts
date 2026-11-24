/** A message a webhook delivered from a conversation agents may have posted in. */
export interface InboundMessage {
  service: string
  container: string
  /** The thread it replies in; null for a message outside any thread. */
  thread: string | null
  message: string
  /** The author's id in that service, a user or a bot. */
  author: string
  author_name: string | null
  bot: boolean
  text: string
  /** A direct message between two people, where replies seldom use threads. */
  direct: boolean
}

/** How Seti reads the messages one webhook sender delivers, to route replies in followed threads. */
export interface ThreadSource {
  service: string
  /** The service as people name it, such as Slack. */
  label: string
  /** Whether the delivery is a message event at all, edits and joins included. */
  isMessage: (payload: unknown) => boolean
  /** A new message someone wrote; null for edits, deletions, joins and anything else. */
  read: (payload: unknown) => InboundMessage | null
  /** A link to a message, in its thread when it has one; null when the workspace is unknown. */
  link: (space: string, container: string, message: string, thread: string) => string | null
}

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const TS = /^\d{10}\.\d{6}$/
const CHANNEL = /^[A-Z0-9]{8,}$/
/** Subtypes of a new message someone wrote, as opposed to edits, deletions and joins. */
const WRITTEN = new Set(['thread_broadcast', 'file_share', 'bot_message', 'me_message'])

const slackEvent = (payload: unknown): Fields | null =>
  isFields(payload) && isFields(payload.event) && payload.event.type === 'message' ? payload.event : null

function authorName(event: Fields): string | null {
  const profile = isFields(event.user_profile) ? event.user_profile : {}
  const bot = isFields(event.bot_profile) ? event.bot_profile : {}
  return text(profile.display_name) ?? text(profile.real_name) ?? text(bot.name) ?? text(event.username)
}

/** A message someone wrote, not an edit, deletion, join or other change. */
const written = (event: Fields) =>
  event.subtype === undefined || (typeof event.subtype === 'string' && WRITTEN.has(event.subtype))

const matching = (value: unknown, pattern: RegExp): string | null => {
  const found = text(value)
  return found !== null && pattern.test(found) ? found : null
}

function readSlack(payload: unknown): InboundMessage | null {
  const event = slackEvent(payload)
  if (event === null || !written(event)) {
    return null
  }
  const ts = matching(event.ts, TS)
  const channel = matching(event.channel, CHANNEL)
  const author = text(event.user) ?? text(event.bot_id)
  if (ts === null || channel === null || author === null) {
    return null
  }
  const thread = matching(event.thread_ts, TS)
  return {
    service: 'slack',
    container: channel,
    thread: thread === ts ? null : thread,
    message: ts,
    author,
    author_name: authorName(event),
    bot: text(event.bot_id) !== null || event.subtype === 'bot_message',
    text: typeof event.text === 'string' ? event.text : '',
    direct: event.channel_type === 'im',
  }
}

function slackLink(space: string, container: string, message: string, thread: string): string | null {
  if (space === '') {
    return null
  }
  const base = `https://${space}.slack.com/archives/${container}/p${message.replace('.', '')}`
  return thread === message ? base : `${base}?thread_ts=${thread}&cid=${container}`
}

const SLACK: ThreadSource = {
  service: 'slack',
  label: 'Slack',
  isMessage: (payload) => slackEvent(payload) !== null,
  read: readSlack,
  link: slackLink,
}

/** The thread source of a service, which is also its webhook sender's id; undefined for others. */
export const threadSource = (id: string): ThreadSource | undefined => (id === SLACK.service ? SLACK : undefined)

import { isDirect, parseMentions, recipientLabel, type TeamDeliveryMode, type TeamMessage } from '@seti/shared'
import { authorLabel } from '../team.js'
import { frontBoolean, parseFrontMatter, renderFrontMatter } from './front-matter.js'
import { rejectionLine } from './objects.js'

export const CHAT_MESSAGES = 20

export interface DeliveryLine {
  handle: string
  mode: TeamDeliveryMode
  reason: string | null
}

export interface ChatView {
  taskId: string
  handle: string
  muted: boolean
  messages: readonly TeamMessage[]
  /** What each of this agent's own messages did, by message id. */
  deliveries: ReadonlyMap<number, readonly DeliveryLine[]>
}

const MODES: Record<TeamDeliveryMode, string> = {
  now: 'joined its running turn',
  next: 'at its next step',
  start: 'started a turn',
  held: 'held for its next turn',
  skipped: 'not delivered',
}

const REASONS: Partial<Record<string, string>> = {
  loop: 'mention loop, add @user to escalate',
  burst: 'too many agent messages',
  idle: 'idle, only a mention wakes it',
}

const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`

function outcome(message: TeamMessage, deliveries: readonly DeliveryLine[]): string {
  const reached = deliveries.map(({ handle, mode, reason }) => {
    const why = reason === null ? '' : `, ${REASONS[reason] ?? reason}`
    return `@${handle} ${MODES[mode]}${why}`
  })
  const handles = new Set(message.mentions.map((mention) => mention.handle))
  const delivered = new Set(deliveries.map((delivery) => delivery.handle))
  const extra = [
    ...(handles.has('ea') ? ['@ea inbox'] : []),
    ...(handles.has('user') ? ['@user flagged'] : []),
    ...message.mentions
      .filter((mention) => mention.task_id !== null && !delivered.has(mention.handle))
      .map((mention) => `@${mention.handle} not reached (archived or deleted)`),
    ...parseMentions(message.text)
      .filter((handle) => !handles.has(handle))
      .map((handle) => `@${handle} unknown`),
  ]
  const all = [...reached, ...extra]
  return `> seti: ${all.length === 0 ? 'no mentions, it stays in the chat' : all.join('; ')}`
}

/** How a heading marks a direct message; only its two parties' chat.md ever shows one. */
const DIRECT_MARK = ', direct to '

function directNote(view: ChatView, message: TeamMessage): string {
  if (!isDirect(message)) {
    return ''
  }
  return `${DIRECT_MARK}${message.to_task_id === view.taskId ? 'you' : (recipientLabel(message) ?? '')}`
}

function renderMessage(view: ChatView, message: TeamMessage): string {
  const own = message.author_kind === 'task' && message.author_task_id === view.taskId
  const who = `${authorLabel(message)}${own ? ' (you)' : ''}${directNote(view, message)}`
  const heading = `### ${String(message.id)} ${who}, ${stamp(message.created_at)}`
  const lines = [heading, message.text.trim()]
  if (own) {
    lines.push(outcome(message, view.deliveries.get(message.id) ?? []))
  }
  return lines.join('\n')
}

export function renderChat(view: ChatView, note: string | null = null): string {
  const header = [
    renderFrontMatter({ muted: view.muted }),
    `# Group chat (you are @${view.handle})`,
    '',
    'To post, append text at the end of this file; everything appended since Seti last rewrote it is one message.',
    'Seti posts it, then rewrites the file with its id and who it reached, and adds new messages as they arrive.',
    'Write only the message body; Seti adds the heading with your handle and time.',
    'For a direct message, start with the line `direct @handle` (or `direct @ea`) and write the text below it;',
    'only you, they and the user see it. Answer a direct message the same way to keep the answer private.',
    'While the last message here is direct, start with `direct @handle` or `public`; Seti posts neither guess.',
    'Set `muted` above to stop messages reaching you on their own; any other edit above the end is put back.',
    ...(note === null ? [] : ['', rejectionLine(note)]),
  ].join('\n')
  const body = view.messages.length === 0 ? ['No messages yet.'] : view.messages.map((m) => renderMessage(view, m))
  return `${[header, ...body].join('\n\n')}\n`
}

/** A version of chat.md Seti wrote, and what it already posted from appends to it. */
export interface ChatBase {
  content: string
  consumed: string
}

export interface ChatEdit {
  /** The muted flag the front matter asks for, or null when it cannot be read. */
  muted: boolean | null
  /** New text after the version the agent appended to, or null when it edited above the end. */
  appended: string | null
  /** Everything after that version, which the version has then consumed. */
  raw: string
  base: ChatBase | null
}

function bodyOf(text: string): { muted: boolean | null; body: string } {
  try {
    const parsed = parseFrontMatter(text)
    return { muted: frontBoolean(parsed.front, 'muted') ?? null, body: parsed.body }
  } catch {
    return { muted: null, body: text }
  }
}

const SETI_LINE = /^### \d+ |^> seti:/

/** Seti's heading and outcome lines new since an older version; an append never repeats them. */
function addedSince(newest: string, older: string): string[] {
  const lines = (text: string) => text.split('\n').map((line) => line.trim())
  const known = new Set(lines(older))
  return lines(newest).filter((line) => SETI_LINE.test(line) && !known.has(line))
}

/** What the agent appended to a version Seti wrote, newest first, minus what was posted. */
export function readChatEdit(text: string, bases: readonly ChatBase[]): ChatEdit {
  const { muted, body } = bodyOf(text)
  const newest = bases[0] === undefined ? '' : bodyOf(bases[0].content).body.trimEnd()
  for (const [index, base] of bases.entries()) {
    const known = bodyOf(base.content).body.trimEnd()
    if (!body.startsWith(known)) {
      continue
    }
    const raw = body.slice(known.length)
    const appended = raw.startsWith(base.consumed) ? raw.slice(base.consumed.length) : raw
    const lines = new Set(appended.split('\n').map((line) => line.trim()))
    if (index > 0 && addedSince(newest, known).some((line) => lines.has(line))) {
      continue
    }
    return { muted, appended, raw, base }
  }
  return { muted, appended: null, raw: '', base: null }
}

export type ChatPost = { to: string | null; text: string } | { refused: string }

const DIRECT_LINE = /^direct:?\s+@([a-z0-9][a-z0-9-]*)\s*:?$/i
const PUBLIC_LINE = /^public\s*:?$/i
const LOOKS_DIRECT = /^(?:direct|dm|private)\b[\s:]*(?:@|$)/i
const HEADING = /^### \d+ /

/** Whether the last message in a version of chat.md Seti wrote is a direct message. */
export function endsDirect(content: string): boolean {
  const heading = content
    .split('\n')
    .filter((line) => HEADING.test(line))
    .at(-1)
  return heading?.includes(DIRECT_MARK) === true
}

/** Splits a `direct @handle` or `public` first line off; the rest is the message. */
function marked(line: string, body: string): ChatPost | null {
  const direct = DIRECT_LINE.exec(line)
  if (direct === null && !PUBLIC_LINE.test(line)) {
    return null
  }
  if (body === '') {
    return { refused: `write the message on the lines below \`${line}\`; it was not posted` }
  }
  return { to: direct?.[1]?.toLowerCase() ?? null, text: body }
}

/**
 * What an append to chat.md posts: a direct message, a public one, or a refusal. An append that
 * could be either is refused rather than posted to everyone.
 */
export function readChatPost(appended: string, afterDirect: boolean): ChatPost {
  const text = appended.trim()
  const [first = '', ...rest] = text.split('\n')
  const line = first.trim()
  const post = marked(line, rest.join('\n').trim())
  if (post !== null) {
    return post
  }
  if (LOOKS_DIRECT.test(line)) {
    return { refused: 'start a direct message with the line `direct @handle` alone, its text below; it was not posted' }
  }
  if (afterDirect) {
    return {
      refused:
        'the last message here is direct: start with `direct @handle` to answer privately or `public` to post to everyone; it was not posted',
    }
  }
  return { to: null, text }
}

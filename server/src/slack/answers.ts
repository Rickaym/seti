import type { SlackName } from '../store/slack-names.js'

/** A Slack MCP call: its tool's own name, such as `slack_read_channel`, and its input. */
export interface SlackCall {
  tool: string
  input: Record<string, unknown>
}

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/
const USER_ID = /^[UW][A-Z0-9]{8,}$/
const DM_ID = /^D[A-Z0-9]{8,}$/
const ANY_ID = /\b[BCDGUW][A-Z0-9]{8,}\b/g
const CHANNEL_NAME = /^[\p{L}\p{N}_.-]{1,80}$/u

const channel = (id: string | undefined, name: string | undefined): SlackName[] =>
  id !== undefined && name !== undefined && CHANNEL_ID.test(id) && CHANNEL_NAME.test(name)
    ? [{ kind: 'channel', id, name }]
    : []

/** A person's name as Slack shows it; never one that carries an id or markup, which could mislead. */
function personName(raw: string | undefined): string | null {
  const name = raw?.trim() ?? ''
  const forged = name.match(ANY_ID) !== null || /[<>|\n]/.test(name)
  return name === '' || name.length > 80 || forged ? null : name
}

function person(id: string | undefined, raw: string | undefined, kind: SlackName['kind'] = 'user'): SlackName[] {
  const name = personName(raw)
  const fits = id !== undefined && (kind === 'user' ? USER_ID : DM_ID).test(id)
  return fits && name !== null ? [{ kind, id, name }] : []
}

/** The answer's own text: the first string of a JSON object, such as `messages`, else the text. */
function answerText(text: string): string {
  const parsed = parseObject(text)
  const first = Object.values(parsed ?? {}).find((value): value is string => typeof value === 'string')
  return first ?? text
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const field = (line: string | undefined, label: string): string | undefined =>
  line?.startsWith(`${label}: `) === true ? line.slice(label.length + 2) : undefined

/** The display name, else the real name, from the two lines a profile keeps them on. */
function profileName(display: string | undefined, real: string | undefined): string | undefined {
  const shown = field(display, 'Display Name')?.trim()
  return shown === undefined || shown === '' ? field(real, 'Real Name') : shown
}

/**
 * Starts of the entries an answer lists, or none when their count differs from the count the
 * answer states: a line someone wrote in a topic or title that looks like an entry adds one.
 */
function entries(lines: readonly string[], start: RegExp, stated: RegExp): number[] {
  const count = Number(lines.map((line) => stated.exec(line)?.[1]).find((n) => n !== undefined) ?? -1)
  const starts = lines.flatMap((line, i) => (start.test(line) ? [i] : []))
  return starts.length === count ? starts : []
}

const textOf = (answer: string) => answerText(answer).split('\n')

/** `Channel: #name (C...)`, the first line of a read of the channel asked for. */
function readChannel(call: SlackCall, answer: string): SlackName[] {
  const [, name, id] = /^Channel: #(\S+) \((?:ID: )?([CG][A-Z0-9]{8,})\)$/.exec(textOf(answer)[0] ?? '') ?? []
  return id === call.input.channel_id ? channel(id, name) : []
}

/** The display or real name under `User ID: U...` of a read of the profile asked for. */
function readProfile(call: SlackCall, answer: string): SlackName[] {
  const [first, username, display, real] = textOf(answer)
  const id = field(first, 'User ID')
  const fits = id === call.input.user_id && field(username, 'Username') !== undefined
  return fits ? person(id, profileName(display, real)) : []
}

/** The author of a thread's parent: `From: Name <email> (U...)` right under the thread's banner. */
function readThread(_call: SlackCall, answer: string): SlackName[] {
  const [banner, from] = textOf(answer)
  if (banner !== '=== THREAD PARENT MESSAGE ===') {
    return []
  }
  const [, name, id] = /^From: (.+?)(?: <[^<>\s]*>)? \(([UW][A-Z0-9]{8,})\)$/.exec(from ?? '') ?? []
  return person(id, name)
}

const PERMALINK = /^Permalink: \[link\]\(https:\/\/[\w.-]+\/archives\/([CG][A-Z0-9]{8,})\)$/

/**
 * `### Result i of N` entries: a channel's `Name:`, the person who made it, and its permalink,
 * which follows a purpose of any number of lines, so an entry with two permalinks says nothing.
 */
function searchChannels(_call: SlackCall, answer: string): SlackName[] {
  const lines = textOf(answer)
  const starts = entries(lines, /^### Result \d+ of \d+$/, /^## Channels \((\d+) results?\)$/)
  return starts.flatMap((i, n) => {
    if (field(lines[i + 3], 'Created') === undefined) {
      return []
    }
    const name = /^#(\S+)$/.exec(field(lines[i + 1], 'Name') ?? '')?.[1]
    const creator = /^(.+) \(<@([UW][A-Z0-9]{8,})>?\)$/.exec(field(lines[i + 2], 'Creator') ?? '')
    const links = lines.slice(i + 4, starts[n + 1] ?? lines.length).flatMap((line) => PERMALINK.exec(line)?.[1] ?? [])
    return [...channel(links.length === 1 ? links[0] : undefined, name), ...person(creator?.[2], creator?.[1])]
  })
}

/** `### #name` or `### DM with Name` entries, each with its `- **ID:**` on the next line. */
function listUserChannels(_call: SlackCall, answer: string): SlackName[] {
  const lines = textOf(answer)
  const id = (line: string | undefined) => /^- \*\*ID:\*\* ([A-Z0-9]+)$/.exec(line ?? '')?.[1]
  return entries(lines, /^### /, /^## .*Channels \(showing (\d+)\b/).flatMap((i) => {
    const heading = lines[i] ?? ''
    const named = /^### #(\S+)$/.exec(heading)?.[1]
    if (named !== undefined) {
      return channel(id(lines[i + 1]), named)
    }
    const dm = /^### DM with (.+)$/.exec(heading)?.[1]
    const user = /^- \*\*User ID:\*\* ([UW][A-Z0-9]{8,})$/.exec(lines[i + 3] ?? '')?.[1]
    const typed = lines[i + 2]?.startsWith('- **Type:** ') === true
    return typed ? [...person(id(lines[i + 1]), dm, 'channel'), ...person(user, dm)] : []
  })
}

/** `N. Name - U... - ...` lines, or `### Result i of N` entries with `Name:` and `User ID:`. */
function searchUsers(_call: SlackCall, answer: string): SlackName[] {
  const lines = textOf(answer)
  const stated = /^## Users \((\d+) results?\)$/
  const detailed = entries(lines, /^### Result \d+ of \d+$/, stated).flatMap((i) =>
    person(field(lines[i + 2], 'User ID'), field(lines[i + 1], 'Name')),
  )
  const concise = entries(lines, /^\d+\. /, stated).flatMap((i) => {
    const line = lines[i] ?? ''
    const [, name, id] = /^\d+\. (.+?) - ([UW][A-Z0-9]{8,})(?: - .*)?$/.exec(line) ?? []
    return line.match(ANY_ID)?.length === 1 ? person(id, name) : []
  })
  return [...detailed, ...concise]
}

/** `## Member i` entries of the detailed form, each with `User ID:` and its names below. */
function listChannelMembers(_call: SlackCall, answer: string): SlackName[] {
  const lines = textOf(answer)
  return entries(lines, /^## Member \d+$/, /^# Channel Members \((\d+)\)$/).flatMap((i) => {
    const fits = field(lines[i + 2], 'Username') !== undefined
    return fits ? person(field(lines[i + 1], 'User ID'), profileName(lines[i + 3], lines[i + 4])) : []
  })
}

/** The `channel_info` a draft's answer carries: the channel's name, or the person a DM is with. */
function draft(_call: SlackCall, answer: string): SlackName[] {
  const info = parseObject(answer)?.channel_info
  if (typeof info !== 'object' || info === null) {
    return []
  }
  const { channel_id: id, name, is_dm: dm } = info as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || typeof dm !== 'boolean') {
    return []
  }
  return dm ? person(id, name, 'channel') : channel(id, name)
}

const READERS: Record<string, (call: SlackCall, answer: string) => SlackName[]> = {
  slack_read_channel: readChannel,
  slack_read_user_profile: readProfile,
  slack_read_thread: readThread,
  slack_search_channels: searchChannels,
  slack_list_user_channels: listUserChannels,
  slack_search_users: searchUsers,
  slack_list_channel_members: listChannelMembers,
  slack_send_message_draft: draft,
}

/** Whether Seti reads names from this Slack tool's answers. */
export const statesNames = (tool: string): boolean => READERS[tool] !== undefined

/**
 * The names the Slack MCP server states for ids in its answer to a call, read only from the
 * places its own format puts them, never from a topic, purpose, title or message (CHN-33).
 */
export function namesInAnswer(call: SlackCall, answer: string): SlackName[] {
  return READERS[call.tool]?.(call, answer) ?? []
}

import type { ToolCall } from '@seti/shared'
import { at, isRecord, parseJson, stringAt, type FoundItem, type ParseResult } from './item.js'
import {
  isConversation,
  isSlackTs,
  refOfUrl,
  slackChannelRef,
  slackHost,
  slackMessageRef,
  slackPermalink,
  slackTime,
} from './refs.js'

const SLACK = /slack/i

/** A text field of the answer with each line's offset, as the Slack MCP server writes it. */
interface Lines {
  key: string
  lines: string[]
  starts: number[]
}

function linesOf(text: string, key: string): Lines | null {
  const parsed = parseJson(text)
  const body = isRecord(parsed) ? stringAt(parsed, key) : null
  if (body === null) {
    return null
  }
  const lines = body.split('\n')
  let offset = 0
  const starts = lines.map((line) => {
    const start = offset
    offset += line.length + 1
    return start
  })
  return { key, lines, starts }
}

/** The locator of lines `from` to `to` (exclusive); null when the range is empty. */
function span(doc: Lines, from: number, to: number): string | null {
  const last = doc.lines[to - 1]
  const start = doc.starts[from]
  const end = doc.starts[to - 1]
  if (to <= from || last === undefined || start === undefined || end === undefined) {
    return null
  }
  return at([doc.key], [start, end + last.length])
}

/** The end of the quoted body that starts at `from`: Slack prefixes every line of it with `>`. */
function quotedEnd(lines: readonly string[], from: number): number {
  let end = from
  while (lines[end]?.startsWith('>') === true) {
    end++
  }
  return end
}

interface Message {
  ts: string
  from: number
  to: number
}

const message = (doc: Lines, item: Message, make: (ts: string) => Omit<FoundItem, 'spans' | 'at'>) => {
  const located = span(doc, item.from, item.to)
  return located === null ? [] : [{ ...make(item.ts), at: slackTime(item.ts), spans: [located] }]
}

const DETAILED = /^=== Message from .+ at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{2,4} === ?$/
const MESSAGE_TS = /^Message TS: (\d{10}\.\d{6})$/
const CHANNEL_LINE = /^Channel: .*\((?:ID: )?([CDG][A-Z0-9]{8,})\)$/

/** Messages of a detailed read: a banner after a blank line, its `Message TS`, then `>` lines. */
function detailedMessages(lines: readonly string[]): Message[] {
  return lines.flatMap((line, i) => {
    const ts = MESSAGE_TS.exec(lines[i + 1] ?? '')?.[1]
    if (!DETAILED.test(line) || lines[i - 1] !== '' || ts === undefined) {
      return []
    }
    return [{ ts, from: i + 2, to: quotedEnd(lines, i + 2) }]
  })
}

/** A channel read: each message of the detailed form, or the whole read of the concise one. */
function readChannel(channel: string): ParseResult {
  return (text, host) => {
    const doc = linesOf(text, 'messages')
    if (doc === null || CHANNEL_LINE.exec(doc.lines[0] ?? '')?.[1] !== channel) {
      return []
    }
    const found = detailedMessages(doc.lines)
    const base = { kind: 'slack' as const, container: channel }
    if (found.length === 0) {
      const permalink = slackPermalink(host, channel)
      return [{ ...base, ref: slackChannelRef(channel), permalink, at: null, spans: [at(['messages'])] }]
    }
    return found.flatMap((item) =>
      message(doc, item, (ts) => ({
        ...base,
        ref: slackMessageRef(channel, ts),
        permalink: slackPermalink(host, channel, ts),
      })),
    )
  }
}

const REPLY = /^--- Reply (\d+) of (\d+) ---$/
const REPLIES = /^=== THREAD REPLIES \((\d+) total\) ===$/

/** Replies of a detailed thread: banner, `From`, `Time`, `Message TS`, `>` lines; all or none. */
function threadReplies(lines: readonly string[]): Message[] {
  const stated = Number(lines.map((line) => REPLIES.exec(line)?.[1]).find((n) => n !== undefined) ?? -1)
  const replies = lines.flatMap((line, i) => {
    const banner = REPLY.exec(line)
    const ts = MESSAGE_TS.exec(lines[i + 3] ?? '')?.[1]
    const fits = banner !== null && Number(banner[2]) === stated && lines[i + 1]?.startsWith('From: ') === true
    return fits && ts !== undefined && lines[i + 2]?.startsWith('Time: ') === true
      ? [{ ts, n: Number(banner[1]), from: i + 4, to: quotedEnd(lines, i + 4) }]
      : []
  })
  const ordered = replies.every((reply, i) => reply.n === i + 1)
  return replies.length === stated && ordered ? replies : []
}

const PARENT = '=== THREAD PARENT MESSAGE ==='

/** The thread as one item named by the call's channel and `ts`, and each detailed reply. */
function readThread(channel: string, thread: string): ParseResult {
  return (text, host) => {
    const doc = linesOf(text, 'messages')
    const first = doc?.lines.find((line) => line !== '')
    if (doc === null || first === undefined) {
      return []
    }
    const detailed = first === PARENT
    const parentTs = detailed ? MESSAGE_TS.exec(doc.lines[doc.lines.indexOf(PARENT) + 3] ?? '')?.[1] : thread
    if ((!detailed && !first.startsWith('THREAD: [')) || parentTs !== thread) {
      return []
    }
    const base = { kind: 'slack' as const, container: channel }
    const whole: FoundItem = {
      ...base,
      ref: slackMessageRef(channel, thread),
      permalink: slackPermalink(host, channel, thread),
      at: slackTime(thread),
      spans: [at(['messages'])],
    }
    const replies = detailed ? threadReplies(doc.lines) : []
    return [
      whole,
      ...replies.flatMap((item) =>
        message(doc, item, (ts) => ({
          ...base,
          ref: slackMessageRef(channel, ts),
          permalink: slackPermalink(host, channel, ts, thread),
        })),
      ),
    ]
  }
}

const RESULT = /^### Result (\d+) of (\d+)$/
const MESSAGES = /^## Messages \((\d+) results?\)$/
const RESULT_TS = /^Message_ts: (\d{10}\.\d{6})$/
const PERMALINK = /^Permalink: \[link\]\((https:\/\/\S+)\)$/
const TEXT_END = new Set(['Context after:', 'Context before:', '---'])

/** Where a hit's `Text:` lines end: at its context, its rule or the next hit. */
function textEnd(lines: readonly string[], from: number, end: number): number {
  let stop = from
  while (stop < end && !TEXT_END.has(lines[stop] ?? '')) {
    stop++
  }
  return stop
}

/** A hit's channel, `ts` and permalink at their fixed places, when the permalink names them. */
function hitFields(lines: readonly string[], i: number): { channel: string; ts: string; link: string } | null {
  const channel = CHANNEL_LINE.exec(lines[i + 1] ?? '')?.[1]
  const ts = RESULT_TS.exec(lines[i + 4] ?? '')?.[1]
  const fits = lines[i + 2]?.startsWith('From: ') === true && lines[i + 3]?.startsWith('Time: ') === true
  const link = lines.slice(i + 5, i + 8).flatMap((line) => PERMALINK.exec(line)?.[1] ?? [])[0]
  if (channel === undefined || ts === undefined || link === undefined || !fits) {
    return null
  }
  return refOfUrl(link)?.ref === slackMessageRef(channel, ts) ? { channel, ts, link } : null
}

/** One search hit: its fields at fixed places, a permalink that names them, and its `Text:` lines. */
function searchHit(doc: Lines, i: number, end: number): FoundItem[] {
  const fields = hitFields(doc.lines, i)
  const textAt = doc.lines.indexOf('Text:', i + 5)
  if (fields === null || textAt < 0 || textAt >= end) {
    return []
  }
  const located = span(doc, textAt + 1, textEnd(doc.lines, textAt + 1, end))
  const { channel, ts, link } = fields
  const ref = slackMessageRef(channel, ts)
  return located === null
    ? []
    : [{ kind: 'slack', container: channel, ref, permalink: link, at: slackTime(ts), spans: [located] }]
}

/** Message hits of a search; none when their count differs from the count the answer states. */
function searchMessages(text: string): FoundItem[] {
  const doc = linesOf(text, 'results')
  if (doc === null) {
    return []
  }
  const header = doc.lines.findIndex((line) => MESSAGES.test(line))
  const next = doc.lines.findIndex((line, i) => i > header && line.startsWith('## '))
  const end = next < 0 ? doc.lines.length : next
  const stated = Number(MESSAGES.exec(doc.lines[header] ?? '')?.[1] ?? -1)
  const starts = doc.lines.flatMap((line, i) => (i > header && i < end && RESULT.test(line) ? [i] : []))
  if (header < 0 || starts.length !== stated) {
    return []
  }
  return starts.flatMap((start, n) => searchHit(doc, start, starts[n + 1] ?? end))
}

const toolOf = (call: ToolCall): string | null =>
  call.mcp !== undefined && SLACK.test(`${call.mcp.server} ${call.mcp.tool}`)
    ? (call.mcp.tool.split('__').at(-1) ?? call.mcp.tool)
    : null

/** The reader of a Slack MCP read's answer, or null for any other call. */
export function slackRead(call: ToolCall): ParseResult | null {
  const tool = toolOf(call)
  const input = isRecord(call.input) ? call.input : {}
  const channel = input.channel_id
  if (tool === 'slack_read_channel' && isConversation(channel)) {
    return readChannel(channel)
  }
  if (tool === 'slack_read_thread' && isConversation(channel) && isSlackTs(input.message_ts)) {
    return readThread(channel, input.message_ts)
  }
  return tool === 'slack_search_public' || tool === 'slack_search_public_and_private' ? searchMessages : null
}

export const isSlackCall = (call: ToolCall): boolean => toolOf(call) !== null

/** The workspace host a Slack answer states in its link fields, such as a send's `message_link`. */
export function slackHostIn(text: string): string | null {
  const parsed = parseJson(text)
  const link = isRecord(parsed) ? (stringAt(parsed, 'message_link') ?? stringAt(parsed, 'channel_link')) : null
  if (link === null || refOfUrl(link) === null) {
    return null
  }
  return slackHost(new URL(link).hostname)
}

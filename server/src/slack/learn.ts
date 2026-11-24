import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { now } from '../db.js'
import { slackNames, type SlackName } from '../store/slack-names.js'

const SLACK = /slack/i
const CHANNEL_HEADER = /^Channel: #([\w.-]{1,80}) \((?:ID: )?([CG][A-Z0-9]{8,})\)$/
const USER_HEADER = /^User ID: ([UW][A-Z0-9]{8,})$/
const PROFILE_NAMES = [/^Display Name: ([^\n]{1,80})$/, /^Real Name: ([^\n]{1,80})$/]
const HEADER_LINES = 12

/** The channel or person a Slack read call asked for by id. */
interface Asked {
  kind: SlackName['kind']
  id: string
}

/** What a Slack MCP read call asked for by id; null for any other call. */
function askedFor(call: ToolCall): Asked | null {
  if (call.mcp === undefined || !SLACK.test(`${call.mcp.server} ${call.mcp.tool}`)) {
    return null
  }
  const input = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {}
  const field = (key: string) => (typeof input[key] === 'string' ? input[key] : null)
  const channel = call.mcp.tool.endsWith('read_channel') ? field('channel_id') : null
  const user = call.mcp.tool.endsWith('read_user_profile') ? field('user_id') : null
  if (channel !== null) {
    return { kind: 'channel', id: channel }
  }
  return user === null ? null : { kind: 'user', id: user }
}

/** The answer's own text: the first string of a JSON object, such as `messages`, else the text. */
function answerText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const values: unknown[] = typeof parsed === 'object' && parsed !== null ? Object.values(parsed) : []
    const first = values.find((value): value is string => typeof value === 'string')
    return first ?? text
  } catch {
    return text
  }
}

/** The lines the Slack MCP server writes before the first blank line, above any message. */
function header(text: string): string[] {
  const lines = answerText(text).split('\n')
  const blank = lines.findIndex((line) => line.trim() === '')
  return lines.slice(0, blank === -1 ? HEADER_LINES : Math.min(blank, HEADER_LINES))
}

function profileName(lines: readonly string[]): string | null {
  for (const pattern of PROFILE_NAMES) {
    const name = lines.map((line) => pattern.exec(line)?.[1]?.trim() ?? '').find((found) => found !== '')
    if (name !== undefined) {
      return name
    }
  }
  return null
}

/**
 * The name the server states for what was asked: `Channel: #name (C...)` as the first line of a
 * channel read, or the display or real name under `User ID: U...` of a profile read.
 */
function headerName(asked: Asked, text: string): SlackName | null {
  const [first = '', ...rest] = header(text)
  if (asked.kind === 'channel') {
    const [, name, id] = CHANNEL_HEADER.exec(first) ?? []
    return name !== undefined && id === asked.id ? { ...asked, name } : null
  }
  const name = USER_HEADER.exec(first)?.[1] === asked.id ? profileName(rest) : null
  return name === null ? null : { ...asked, name }
}

/** Notes a Slack read that starts, or reads the name the answer to one states when it ends. */
function step(calls: Map<string, Asked>, event: RuntimeEvent): SlackName | null {
  if (event.type === 'tool.started') {
    const asked = askedFor(event.call)
    if (asked !== null) {
      calls.set(event.call.callId, asked)
    }
    return null
  }
  const call = event.type === 'tool.ended' ? calls.get(event.callId) : undefined
  if (event.type !== 'tool.ended' || call === undefined) {
    return null
  }
  calls.delete(event.callId)
  return event.status === 'ok' ? headerName(call, event.result.text) : null
}

/** Tracks Slack read calls per task and yields the name each answer states for what it asked. */
function createSlackReadWatcher() {
  const pending = new Map<string, Map<string, Asked>>()
  return (taskId: string, events: readonly RuntimeEvent[]): SlackName[] => {
    const calls = pending.get(taskId) ?? new Map<string, Asked>()
    pending.set(taskId, calls)
    const names = events.flatMap((event) => step(calls, event) ?? [])
    if (calls.size === 0) {
      pending.delete(taskId)
    }
    return names
  }
}

const watchSlackReads = createSlackReadWatcher()

/**
 * Learns the names the Slack MCP server states for a channel or person an agent read by id, never
 * from message text, which anyone in Slack writes (CHN-33).
 */
export async function learnSlackNames(taskId: string, events: readonly RuntimeEvent[]): Promise<void> {
  const names = watchSlackReads(taskId, events)
  if (names.length > 0) {
    await slackNames.learn(names, 'agent tool result', now())
  }
}

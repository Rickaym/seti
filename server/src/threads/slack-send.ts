import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { shellCommand } from '../outward.js'
import type { SentMessage } from '../store/threads.js'

const MCP_SEND = /(?:^|_)send_message$/i
const SLACK = /slack/i
const SHELL_SEND = /\bchat\.postMessage\b/
const LINK = /https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})([?][^\s)"'<>\]]*)?/i
const THREAD_QUERY = /[?&]thread_ts=(\d{10}\.\d{6})/
const TS = /^\d{10}\.\d{6}$/
const CHANNEL = /^[A-Z0-9]{8,}$/

/** A Slack MCP server's send_message, or chat.postMessage called from the shell. */
function sendsSlackMessage(call: ToolCall): boolean {
  if (call.mcp !== undefined) {
    return MCP_SEND.test(call.mcp.tool) && SLACK.test(`${call.mcp.server} ${call.mcp.tool}`)
  }
  return SHELL_SEND.test(shellCommand(call))
}

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tsOf = (value: unknown): string | null => (typeof value === 'string' && TS.test(value) ? value : null)

function jsonOf(text: string): Fields | null {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    return isFields(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The message a Web API chat.postMessage answer reports, as `{ok, channel, ts, message}`. */
function fromApiAnswer(answer: Fields, inputThread: string | null): SentMessage | null {
  const ts = tsOf(answer.ts)
  const channel = typeof answer.channel === 'string' && CHANNEL.test(answer.channel) ? answer.channel : null
  if (answer.ok !== true || ts === null || channel === null) {
    return null
  }
  const message = isFields(answer.message) ? answer.message : {}
  const thread = tsOf(message.thread_ts) ?? inputThread ?? ts
  return { service: 'slack', space: '', container: channel, thread, message: ts, url: null }
}

/** The message a Slack message link names, such as an MCP server's answer carries. */
function fromLink(text: string, inputThread: string | null): SentMessage | null {
  const link = LINK.exec(text)
  if (link === null) {
    return null
  }
  const [url, space = '', channel = '', seconds = '', micros = '', query = ''] = link
  const ts = `${seconds}.${micros}`
  const thread = THREAD_QUERY.exec(query)?.[1] ?? inputThread ?? ts
  return { service: 'slack', space: space.toLowerCase(), container: channel.toUpperCase(), thread, message: ts, url }
}

/**
 * The Slack message a successful send reported, read from its result: a Web API answer, else the
 * first Slack message link. Null when the result names no channel and timestamp.
 */
function slackSent(call: ToolCall, resultText: string): SentMessage | null {
  const input = isFields(call.input) ? call.input : {}
  const inputThread = tsOf(input.thread_ts)
  const answer = jsonOf(resultText)
  return (answer === null ? null : fromApiAnswer(answer, inputThread)) ?? fromLink(resultText, inputThread)
}

/** Tracks Slack sends per task and yields each message a send that ended well reported. */
export function createSlackSendWatcher() {
  const pending = new Map<string, Map<string, ToolCall>>()

  return (taskId: string, events: readonly RuntimeEvent[]): SentMessage[] => {
    const calls = pending.get(taskId) ?? new Map<string, ToolCall>()
    pending.set(taskId, calls)
    const sent: SentMessage[] = []
    for (const event of events) {
      if (event.type === 'tool.started' && sendsSlackMessage(event.call)) {
        calls.set(event.call.callId, event.call)
      }
      if (event.type !== 'tool.ended') {
        continue
      }
      const call = calls.get(event.callId)
      calls.delete(event.callId)
      const message = call !== undefined && event.status === 'ok' ? slackSent(call, event.result.text) : null
      if (message !== null) {
        sent.push(message)
      }
    }
    if (calls.size === 0) {
      pending.delete(taskId)
    }
    return sent
  }
}

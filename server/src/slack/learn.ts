import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { now } from '../db.js'
import type { SlackName } from '../store/slack-names.js'
import { namesInAnswer, statesNames, type SlackCall } from './answers.js'
import { rememberSlackNames } from './directory.js'

const SLACK = /slack/i

/** The Slack MCP call a tool call makes, when Seti reads names from its answer; null otherwise. */
function slackCall(call: ToolCall): SlackCall | null {
  if (call.mcp === undefined || !SLACK.test(`${call.mcp.server} ${call.mcp.tool}`)) {
    return null
  }
  const tool = call.mcp.tool.split('__').at(-1) ?? call.mcp.tool
  const input = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {}
  return statesNames(tool) ? { tool, input } : null
}

/** Notes a Slack call that starts, or reads the names the answer to one states when it ends. */
function step(calls: Map<string, SlackCall>, event: RuntimeEvent): SlackName[] {
  if (event.type === 'tool.started') {
    const call = slackCall(event.call)
    if (call !== null) {
      calls.set(event.call.callId, call)
    }
    return []
  }
  const call = event.type === 'tool.ended' ? calls.get(event.callId) : undefined
  if (event.type !== 'tool.ended' || call === undefined) {
    return []
  }
  calls.delete(event.callId)
  return event.status === 'ok' ? namesInAnswer(call, event.result.text) : []
}

/** Tracks Slack calls per task and yields the names each answer states. */
function createSlackCallWatcher() {
  const pending = new Map<string, Map<string, SlackCall>>()
  return (taskId: string, events: readonly RuntimeEvent[]): SlackName[] => {
    const calls = pending.get(taskId) ?? new Map<string, SlackCall>()
    pending.set(taskId, calls)
    const names = events.flatMap((event) => step(calls, event))
    if (calls.size === 0) {
      pending.delete(taskId)
    }
    return names
  }
}

const watchSlackCalls = createSlackCallWatcher()

/**
 * Learns the names the Slack MCP server states for channels and people in its answers to an
 * agent's calls, never from a topic, title or message, which anyone in Slack writes (CHN-33).
 */
export async function learnSlackNames(taskId: string, events: readonly RuntimeEvent[]): Promise<void> {
  const names = watchSlackCalls(taskId, events)
  if (names.length > 0) {
    await rememberSlackNames(names, 'agent tool result', now())
  }
}

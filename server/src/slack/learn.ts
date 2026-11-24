import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { now } from '../db.js'
import { slackNames } from '../store/slack-names.js'
import { namesIn } from './names.js'

const SLACK = /slack/i

const isSlackTool = (call: ToolCall) => call.mcp !== undefined && SLACK.test(`${call.mcp.server} ${call.mcp.tool}`)

/** Tracks Slack MCP calls per task and yields the text of each that ended well. */
function createSlackResultWatcher() {
  const pending = new Map<string, Set<string>>()
  return (taskId: string, events: readonly RuntimeEvent[]): string[] => {
    const calls = pending.get(taskId) ?? new Set<string>()
    pending.set(taskId, calls)
    const texts: string[] = []
    for (const event of events) {
      if (event.type === 'tool.started' && isSlackTool(event.call)) {
        calls.add(event.call.callId)
      }
      if (event.type === 'tool.ended' && calls.delete(event.callId) && event.status === 'ok') {
        texts.push(event.result.text)
      }
    }
    if (calls.size === 0) {
      pending.delete(taskId)
    }
    return texts
  }
}

const watchSlackResults = createSlackResultWatcher()

/** Learns the Slack names an agent's Slack MCP calls returned beside their ids. */
export async function learnSlackNames(taskId: string, events: readonly RuntimeEvent[]): Promise<void> {
  const names = watchSlackResults(taskId, events).flatMap(namesIn)
  if (names.length > 0) {
    await slackNames.learn(names, 'agent tool result', now())
  }
}

import type { ClaudeMessage } from '@seti/shared'
import { nodeLink } from '../node-link.js'

let calls = 0

/** The agent makes one tool call on Claude Code and Seti ingests the call and its answer. */
export async function claudeCall(task: string, name: string, input: object, answer: string): Promise<void> {
  const id = `toolu_${String(++calls)}`
  const use = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }
  const result = {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: answer }] },
  }
  for (const payload of [use, result] as unknown as ClaudeMessage[]) {
    await nodeLink.journal(task, { type: 'message', runtime: 'claude', payload })
  }
}

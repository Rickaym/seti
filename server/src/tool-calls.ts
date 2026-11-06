import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface OpenToolCall {
  name: string
  /** The Bash command, cut to a line's length; null for every other tool. */
  command: string | null
  /** The subagent tool call this call belongs to; null for the task's own agent. */
  parent: string | null
  since: number
}

const COMMAND_MAX = 200

/** Tools that wait on subagents rather than run anything themselves. */
const CONTAINER_TOOLS = new Set(['Agent', 'Task'])

/** Tool calls each task's agent started and has no result for yet, by tool use id. */
const open = new Map<string, Map<string, OpenToolCall>>()

function commandOf(name: string, input: unknown): string | null {
  if (name !== 'Bash' || typeof input !== 'object' || input === null || !('command' in input)) {
    return null
  }
  const { command } = input
  if (typeof command !== 'string') {
    return null
  }
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX - 3)}...` : line
}

function opened(calls: Map<string, OpenToolCall>, m: SDKAssistantMessage, now: number): void {
  for (const block of m.message.content) {
    if (block.type === 'tool_use') {
      const command = commandOf(block.name, block.input)
      calls.set(block.id, { name: block.name, command, parent: m.parent_tool_use_id, since: now })
    }
  }
}

function closed(calls: Map<string, OpenToolCall>, m: SDKUserMessage): void {
  if (typeof m.message.content === 'string') {
    return
  }
  for (const block of m.message.content) {
    if (block.type === 'tool_result') {
      calls.delete(block.tool_use_id)
    }
  }
}

/** Follows tool calls through a task's SDK messages; a result ends the turn's own calls. */
export function trackToolCalls(taskId: string, m: SDKMessage, now = Date.now()): void {
  const calls = open.get(taskId) ?? new Map<string, OpenToolCall>()
  if (m.type === 'assistant') {
    opened(calls, m, now)
  } else if (m.type === 'user') {
    closed(calls, m)
  } else if (m.type === 'result') {
    for (const [id, call] of calls) {
      if (call.parent === null) {
        calls.delete(id)
      }
    }
  }
  if (calls.size === 0) {
    open.delete(taskId)
  } else {
    open.set(taskId, calls)
  }
}

/** The newest open call that runs something itself, not a subagent wait; `own` skips subagents'. */
export function currentToolCall(taskId: string, own = false): OpenToolCall | null {
  let newest: OpenToolCall | null = null
  for (const call of open.get(taskId)?.values() ?? []) {
    const counted = !CONTAINER_TOOLS.has(call.name) && (!own || call.parent === null)
    if (counted && (newest === null || call.since >= newest.since)) {
      newest = call
    }
  }
  return newest
}

/** Every open call that runs something itself, by task id; subagent waits are left out. */
export function openToolCalls(): { taskId: string; call: OpenToolCall }[] {
  return [...open].flatMap(([taskId, calls]) =>
    [...calls.values()].filter((call) => !CONTAINER_TOOLS.has(call.name)).map((call) => ({ taskId, call })),
  )
}

/** The Bash command of a call the agent started and has no result for yet, else null. */
export const openCommand = (taskId: string, toolUseId: string): string | null =>
  open.get(taskId)?.get(toolUseId)?.command ?? null

export function forgetToolCalls(taskId: string): void {
  open.delete(taskId)
}

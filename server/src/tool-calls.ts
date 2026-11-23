import type { RuntimeEvent, ToolCall } from '@seti/shared'

export interface OpenToolCall {
  name: string
  /** The shell command it runs, cut to a line's length; null for every other call. */
  command: string | null
  /** The subagent call this call belongs to; null for the task's own agent. */
  parent: string | null
  /** It waits on a subagent rather than running anything itself. */
  waits: boolean
  since: number
}

const COMMAND_MAX = 200

/** Tool calls each task's agent started and has no result for yet, by tool use id. */
const open = new Map<string, Map<string, OpenToolCall>>()

function commandOf(call: ToolCall): string | null {
  const command = call.shell?.action === 'run' ? call.shell.command : undefined
  if (command === undefined) {
    return null
  }
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX - 3)}...` : line
}

function follow(calls: Map<string, OpenToolCall>, event: RuntimeEvent, now: number): void {
  if (event.type === 'tool.started') {
    const { call, thread } = event
    calls.set(call.callId, {
      name: call.name,
      command: commandOf(call),
      parent: thread === '' ? null : thread,
      waits: call.kind === 'subagent',
      since: now,
    })
  } else if (event.type === 'tool.ended') {
    calls.delete(event.callId)
  } else if (event.type === 'turn.ended') {
    for (const [id, call] of calls) {
      if (call.parent === null) {
        calls.delete(id)
      }
    }
  }
}

/** Follows tool calls through a task's runtime events; a turn's end ends its own calls. */
export function trackToolCalls(taskId: string, events: readonly RuntimeEvent[], now = Date.now()): void {
  const calls = open.get(taskId) ?? new Map<string, OpenToolCall>()
  for (const event of events) {
    follow(calls, event, now)
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
    const counted = !call.waits && (!own || call.parent === null)
    if (counted && (newest === null || call.since >= newest.since)) {
      newest = call
    }
  }
  return newest
}

/** Every open call that runs something itself, by task id; subagent waits are left out. */
export function openToolCalls(): { taskId: string; call: OpenToolCall }[] {
  return [...open].flatMap(([taskId, calls]) =>
    [...calls.values()].filter((call) => !call.waits).map((call) => ({ taskId, call })),
  )
}

/** The shell command of a call the agent started and has no result for yet, else null. */
export const openCommand = (taskId: string, toolUseId: string): string | null =>
  open.get(taskId)?.get(toolUseId)?.command ?? null

export function forgetToolCalls(taskId: string): void {
  open.delete(taskId)
}

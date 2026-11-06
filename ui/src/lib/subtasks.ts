import { runningSubtasks, type SubtaskBrief, type SubtaskStatus } from '@seti/shared'
import { elapsedLabel } from '@/lib/time'

/** Tool names that start a subagent; older Claude Code versions call it Task. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])

export const isAgentTool = (name: string) => AGENT_TOOLS.has(name)

export const subtaskRouteId = (taskId: string, toolUseId: string) => `${taskId}/sub/${toolUseId}`

/** How long a subtask ran, or has run so far; null when it never reported an end. */
export function subtaskElapsed(subtask: SubtaskBrief, now: number): string | null {
  if (subtask.status === 'running') {
    return elapsedLabel(now - Date.parse(subtask.started_at))
  }
  return subtask.ended_at === null ? null : elapsedLabel(Date.parse(subtask.ended_at) - Date.parse(subtask.started_at))
}

const kiloTokens = (tokens: number) => `${(tokens / 1000).toFixed(1)}k tokens`

/** A one-line account of where a subtask is: its last tool and totals, or how it ended. */
export function progressLine(subtask: SubtaskBrief): string | null {
  if (subtask.status !== 'running') {
    return subtask.summary
  }
  const parts = [
    subtask.progress?.summary ?? null,
    subtask.progress?.last_tool === null || subtask.progress === null ? null : `last: ${subtask.progress.last_tool}`,
    subtask.usage === null ? null : `${String(subtask.usage.tool_uses)} tool uses`,
    subtask.usage === null ? null : kiloTokens(subtask.usage.total_tokens),
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'starting' : parts.join(' | ')
}

const sameBrief = (a: SubtaskBrief, b: SubtaskBrief) => JSON.stringify(a) === JSON.stringify(b)

/** The new list, reusing the objects of subtasks that did not change so memoized rows keep still. */
export function mergeBriefs(prev: readonly SubtaskBrief[], next: readonly SubtaskBrief[]): readonly SubtaskBrief[] {
  const old = new Map(prev.map((subtask) => [subtask.tool_use_id, subtask]))
  const merged = next.map((subtask) => {
    const kept = old.get(subtask.tool_use_id)
    return kept !== undefined && sameBrief(kept, subtask) ? kept : subtask
  })
  const unchanged = merged.length === prev.length && merged.every((subtask, index) => subtask === prev[index])
  return unchanged ? prev : merged
}

export interface SubtaskNode {
  subtask: SubtaskBrief
  depth: number
}

/** Subtasks nested under their starters; running branches lead their siblings, then start order. */
export function subtaskTree(subtasks: readonly SubtaskBrief[]): SubtaskNode[] {
  const known = new Set(subtasks.map((subtask) => subtask.tool_use_id))
  const children = new Map<string | null, SubtaskBrief[]>()
  for (const subtask of subtasks) {
    const parent =
      subtask.parent_tool_use_id !== null && known.has(subtask.parent_tool_use_id) ? subtask.parent_tool_use_id : null
    children.set(parent, [...(children.get(parent) ?? []), subtask])
  }
  const live = new Map<string, boolean>()
  const isLive = (subtask: SubtaskBrief): boolean => {
    const cached = live.get(subtask.tool_use_id)
    if (cached !== undefined) {
      return cached
    }
    live.set(subtask.tool_use_id, false)
    const result =
      subtask.status === 'running' || (children.get(subtask.tool_use_id) ?? []).some((child) => isLive(child))
    live.set(subtask.tool_use_id, result)
    return result
  }
  const nodes: SubtaskNode[] = []
  const walk = (parent: string | null, depth: number) => {
    const siblings = children.get(parent) ?? []
    for (const subtask of [...siblings.filter(isLive), ...siblings.filter((sibling) => !isLive(sibling))]) {
      nodes.push({ subtask, depth })
      walk(subtask.tool_use_id, depth + 1)
    }
  }
  walk(null, 0)
  return nodes
}

/** Statuses in the order a summary names them: work still going, then what needs a look. */
const SUBTASK_ORDER: readonly SubtaskStatus[] = ['running', 'failed', 'stopped', 'completed', 'unknown']

export const SUBTASK_LABEL: Record<SubtaskStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'no report',
}

/** How many subtasks have each status, in summary order, leaving out statuses none has. */
export function subtaskCounts(subtasks: readonly Pick<SubtaskBrief, 'status'>[]) {
  return SUBTASK_ORDER.map((status) => ({
    status,
    count: subtasks.filter((subtask) => subtask.status === status).length,
  })).filter(({ count }) => count > 0)
}

/** "3 subagents, 1 running, 1 failed": the total, then the count of each status but done. */
export function subagentsLabel(subtasks: readonly Pick<SubtaskBrief, 'status'>[]): string {
  const total = `${String(subtasks.length)} ${subtasks.length === 1 ? 'subagent' : 'subagents'}`
  const parts = subtaskCounts(subtasks)
    .filter(({ status }) => status !== 'completed')
    .map(({ status, count }) => `${String(count)} ${SUBTASK_LABEL[status]}`)
  return [total, ...parts].join(', ')
}

/** The header badge: how many subagents run now, or null while none does. */
export function runningBadge(subtasks: readonly Pick<SubtaskBrief, 'status'>[]): string | null {
  const running = runningSubtasks(subtasks)
  return running === 0 ? null : String(running)
}

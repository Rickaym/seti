import { z } from 'zod'
import { lenientArray, opaque, orDefault, type ResponseSchema } from './lenient.js'
import { displayStatus, taskFields, type PrStates, type Task, type TaskDisplayStatus } from './tasks.js'
import { agentTodoSchema, type AgentTodo } from './todos.js'

/** `unknown`: the rows end before any outcome, as in sessions imported from a terminal. */
export const SUBTASK_STATUSES = ['running', 'completed', 'failed', 'stopped', 'unknown'] as const
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number]

export interface SubtaskUsage {
  total_tokens: number
  tool_uses: number
  duration_ms: number
}

/** The latest progress report of a running subagent. */
export interface SubtaskProgress {
  description: string
  last_tool: string | null
  summary: string | null
}

/** A subagent a task's agent started with the Agent tool, derived from the task's messages. */
export interface SubtaskBrief {
  /** Id of the Agent tool call that started it. */
  tool_use_id: string
  /** Tool calls whose messages belong to it: the Agent call and SendMessage calls that resumed it. */
  tool_use_ids: string[]
  /** The subtask that started this one, for nested subagents; null when the task's agent did. */
  parent_tool_use_id: string | null
  /** Id of the stored message holding the Agent call. */
  message_id: number
  /** The Agent SDK's id for the running subagent, once it reported one. */
  sdk_task_id: string | null
  description: string
  subagent_type: string | null
  background: boolean
  status: SubtaskStatus
  progress: SubtaskProgress | null
  usage: SubtaskUsage | null
  started_at: string
  ended_at: string | null
  /** First line of the result, clipped. */
  summary: string | null
  /** PRs linked to this subagent, such as those it opened, oldest link first. */
  pr_urls: string[]
}

export interface Subtask extends SubtaskBrief {
  prompt: string
  /** The subagent's final report, trimmed for display like tool output. */
  result: string | null
}

/** How many of a task's subtasks have each status, over its whole history. */
export type SubtaskCounts = Record<SubtaskStatus, number>

/**
 * A task as the task list shows it. The list leaves out ended subtasks: the task's stream and
 * `GET /tasks/:id/subtasks` carry every subtask.
 */
export interface TaskListEntry extends Task {
  /** The subtasks running now, in start order. */
  running_subtasks: SubtaskBrief[]
  subtask_counts: SubtaskCounts
  /** The todo list the agent keeps with Claude Code's own tools; empty when it keeps none. */
  todos: AgentTodo[]
  pr_states: PrStates
}

/** The list's view of a task's subtasks: counts of all of them, and the running ones. */
export function listedSubtasks(
  subtasks: readonly SubtaskBrief[],
): Pick<TaskListEntry, 'running_subtasks' | 'subtask_counts'> {
  const counts: SubtaskCounts = { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 }
  for (const subtask of subtasks) {
    counts[subtask.status] += 1
  }
  return {
    running_subtasks: subtasks.filter((subtask) => subtask.status === 'running'),
    subtask_counts: counts,
  }
}

/** The status a list entry shows; `running` replaces its running count with a fresher one. */
export const listedStatus = (
  entry: Pick<TaskListEntry, 'status' | 'pr_urls' | 'asking' | 'blocked' | 'pr_states' | 'subtask_counts'>,
  running: number = entry.subtask_counts.running,
): TaskDisplayStatus => displayStatus(entry, entry.pr_states, running)

const subtaskBriefSchema = z.object({
  tool_use_id: z.string(),
  tool_use_ids: orDefault('subtask tool_use_ids', z.array(z.string()), []),
  parent_tool_use_id: orDefault('subtask parent', z.string().nullable(), null),
  message_id: z.number(),
  sdk_task_id: orDefault('subtask sdk_task_id', z.string().nullable(), null),
  description: orDefault('subtask description', z.string(), ''),
  subagent_type: orDefault('subtask type', z.string().nullable(), null),
  background: orDefault('subtask background', z.boolean(), false),
  status: orDefault<SubtaskStatus>('subtask status', z.enum(SUBTASK_STATUSES), 'unknown'),
  progress: opaque<SubtaskProgress>('subtask progress'),
  usage: opaque<SubtaskUsage>('subtask usage'),
  started_at: z.string(),
  ended_at: orDefault('subtask ended_at', z.string().nullable(), null),
  summary: orDefault('subtask summary', z.string().nullable(), null),
  pr_urls: orDefault('subtask pr_urls', z.array(z.string()), []),
})

const subtaskCount = (status: SubtaskStatus) => orDefault(`subtask count ${status}`, z.number().int().nonnegative(), 0)

const taskListEntrySchema = z.object({
  ...taskFields,
  running_subtasks: lenientArray('subtask', subtaskBriefSchema),
  subtask_counts: orDefault<SubtaskCounts>(
    'subtask counts',
    z.object({
      running: subtaskCount('running'),
      completed: subtaskCount('completed'),
      failed: subtaskCount('failed'),
      stopped: subtaskCount('stopped'),
      unknown: subtaskCount('unknown'),
    }),
    { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 },
  ),
  todos: lenientArray('todo', agentTodoSchema),
  pr_states: orDefault<PrStates>(
    'pr_states',
    z.object({
      by_url: z.record(z.string(), z.enum(['open', 'merged', 'closed'])),
      any_merged: z.boolean(),
    }),
    { by_url: {}, any_merged: false },
  ),
}) satisfies ResponseSchema<TaskListEntry>

/** The task list; an entry too broken to show drops out instead of breaking the list. */
export const taskListSchema = lenientArray('agent', taskListEntrySchema) satisfies ResponseSchema<TaskListEntry[]>

export const subtaskParams = z.object({
  id: z.string().min(1),
  tool_use_id: z.string().min(1),
})

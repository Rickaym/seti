import type { AgentTodo, MessagePage, Subtask, SubtaskBrief } from '@seti/shared'
import { forgetShells } from './background-shells.js'
import { eachMessageAfter } from './message-pages.js'
import { subtaskMessages, subtaskPrs } from './store/subtasks.js'
import { SubtaskIndex } from './subtasks.js'
import { TodoIndex } from './todos.js'

/** What one task's messages fold into: its subtasks and its agent's todo list. */
interface Folded {
  subtasks: SubtaskIndex
  todos: TodoIndex
}

/** Which of a task's folded views the messages stored since the last look changed. */
interface FoldChanges {
  subtasks: boolean
  todos: boolean
}

const UNCHANGED: FoldChanges = { subtasks: false, todos: false }

const indexes = new Map<string, Folded>()
/** Catch-ups of one task run one at a time, so no message is folded into its index twice. */
const catchUps = new Map<string, Promise<FoldChanges>>()

/** Folds messages stored since the last look into the task's indexes. */
async function catchUp(taskId: string, index: Folded): Promise<FoldChanges> {
  const run = async () => {
    const changed = { ...UNCHANGED }
    await eachMessageAfter(taskId, index.subtasks.lastId, (row) => {
      changed.subtasks = index.subtasks.apply(row) || changed.subtasks
      changed.todos = index.todos.apply(row) || changed.todos
    })
    return changed
  }
  const next = (catchUps.get(taskId) ?? Promise.resolve(UNCHANGED)).then(run, run)
  catchUps.set(taskId, next)
  const forget = () => {
    if (catchUps.get(taskId) === next) {
      catchUps.delete(taskId)
    }
  }
  void next.then(forget, forget)
  return next
}

async function indexOf(taskId: string): Promise<Folded> {
  let index = indexes.get(taskId)
  if (!index) {
    index = { subtasks: new SubtaskIndex(), todos: new TodoIndex() }
    indexes.set(taskId, index)
  }
  await catchUp(taskId, index)
  return index
}

/** The subtasks with the PRs linked to each; tasks without subtasks skip the query. */
async function withPrs<T extends SubtaskBrief>(taskId: string, subtasks: T[]): Promise<T[]> {
  if (subtasks.length === 0) {
    return subtasks
  }
  const links = await subtaskPrs.ofTask(taskId)
  return links.size === 0
    ? subtasks
    : subtasks.map((subtask) => ({ ...subtask, pr_urls: links.get(subtask.tool_use_id) ?? [] }))
}

/** Subtasks of a task, reading only the messages stored since the previous call. */
export const subtaskBriefs = async (taskId: string, openSince: number | null): Promise<SubtaskBrief[]> =>
  withPrs(taskId, (await indexOf(taskId)).subtasks.briefs(openSince))

/** The todo list of the task's agent, reading only the messages stored since the previous call. */
export const agentTodos = async (taskId: string): Promise<AgentTodo[]> => (await indexOf(taskId)).todos.todos()

export async function subtaskOf(taskId: string, toolUseId: string, openSince: number | null): Promise<Subtask | null> {
  const found = (await indexOf(taskId)).subtasks.find(toolUseId, openSince)
  return found && ((await withPrs(taskId, [found]))[0] ?? found)
}

/** What new messages changed; nothing for tasks nobody has asked about yet. */
export async function foldedChanges(taskId: string): Promise<FoldChanges> {
  const index = indexes.get(taskId)
  return index === undefined ? UNCHANGED : catchUp(taskId, index)
}

/** Whether a subtask was running in the query that started at message `since`. */
export const hadRunningSubtask = async (taskId: string, since: number) =>
  (await indexOf(taskId)).subtasks.briefs(since).some((subtask) => subtask.status === 'running')

export const subtaskPage = async (
  taskId: string,
  subtask: Subtask,
  limit: number,
  before?: number,
): Promise<MessagePage> => subtaskMessages.page(taskId, subtask.tool_use_ids, limit, before)

/** Drops what the task's messages were folded into: subtasks, todos and background shells. */
export function forgetSubtasks(taskId: string): void {
  indexes.delete(taskId)
  forgetShells(taskId)
}

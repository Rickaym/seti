import { z } from 'zod'
import { orDefault } from './lenient.js'

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/** One item of the todo list an agent keeps with Claude Code's TodoWrite or task tools. */
export interface AgentTodo {
  /** The task tools' id, or the item's place in a TodoWrite list. */
  id: string
  content: string
  /** What the item reads as while in progress, such as "Running tests"; null when unset. */
  active_form: string | null
  status: TodoStatus
}

export const agentTodoSchema = z.object({
  id: z.string(),
  content: orDefault('todo content', z.string(), ''),
  active_form: orDefault('todo active_form', z.string().nullable(), null),
  status: orDefault<TodoStatus>('todo status', z.enum(TODO_STATUSES), 'pending'),
})

export interface TodoProgress {
  done: number
  total: number
  /** The first item in progress, or null when none is. */
  current: AgentTodo | null
}

export function todoProgress(todos: readonly AgentTodo[]): TodoProgress {
  return {
    done: todos.filter((todo) => todo.status === 'completed').length,
    total: todos.length,
    current: todos.find((todo) => todo.status === 'in_progress') ?? null,
  }
}

/** The item as it reads now: its active form while in progress, else its text. */
export const todoText = (todo: AgentTodo): string =>
  todo.status === 'in_progress' && todo.active_form !== null ? todo.active_form : todo.content

/** One line for the list, such as `3/7 done, now: Running tests`; null without todos. */
export function todoSummary(todos: readonly AgentTodo[]): string | null {
  const { done, total, current } = todoProgress(todos)
  if (total === 0) {
    return null
  }
  const counts = `${String(done)}/${String(total)} done`
  return current === null ? counts : `${counts}, now: ${todoText(current)}`
}

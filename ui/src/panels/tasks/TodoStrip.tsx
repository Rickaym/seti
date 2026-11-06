import { todoProgress, todoText, type AgentTodo, type TaskDisplayStatus } from '@seti/shared'
import { ChevronRight, ListTodo } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { cn } from '@/lib/utils'
import { TodoLight } from '@/panels/tasks/StatusPill'

const openKey = (taskId: string) => `seti.agent.todos-open.${taskId}`

function storedOpen(taskId: string): boolean {
  try {
    return localStorage.getItem(openKey(taskId)) === '1'
  } catch {
    return false
  }
}

function storeOpen(taskId: string, open: boolean): void {
  try {
    localStorage.setItem(openKey(taskId), open ? '1' : '0')
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}

const LINE = 'px-5 max-md:px-3 in-data-agent-frame:px-2'

function stripLabel(counts: string, lead: AgentTodo | null): string {
  if (lead === null) {
    return `Todos: ${counts}`
  }
  return `Todos: ${counts}; ${lead.status === 'in_progress' ? 'now' : 'next'}: ${todoText(lead)}`
}

/** The list as shown: open items in the agent's order, then the completed ones. */
function doneLast(todos: readonly AgentTodo[]): AgentTodo[] {
  return [
    ...todos.filter((todo) => todo.status !== 'completed'),
    ...todos.filter((todo) => todo.status === 'completed'),
  ]
}

/** The item the folded line names: the one in progress, else the next one, else none. */
function headline(todos: readonly AgentTodo[]): AgentTodo | null {
  return todoProgress(todos).current ?? todos.find((todo) => todo.status === 'pending') ?? null
}

interface TodoStripProps {
  taskId: string
  todos: readonly AgentTodo[]
  /** The agent's status, which an item in progress shows. */
  agent: TaskDisplayStatus
}

/** The agent's own todo list under its header: one line of where it is, unfolding into every item. */
export const TodoStrip = memo(function TodoStripView({ taskId, todos, agent }: TodoStripProps) {
  const [open, setOpen] = useState(() => storedOpen(taskId))
  const list = useId()
  if (todos.length === 0) {
    return null
  }
  const { done, total } = todoProgress(todos)
  const lead = headline(todos)
  const counts = `${String(done)}/${String(total)} done`
  const toggle = () => {
    setOpen(!open)
    storeOpen(taskId, !open)
  }
  return (
    <section aria-label="Todos" data-testid="todo-strip" className="shrink-0 border-b border-border typing:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        aria-label={stripLabel(counts, lead)}
        onClick={toggle}
        className={cn(
          LINE,
          'flex h-7 w-full items-center gap-1.5 text-left text-2xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11',
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <ListTodo className="size-3 shrink-0" aria-hidden />
        {lead === null ? (
          <span className="min-w-0 flex-1 truncate font-semibold text-foreground">All done</span>
        ) : (
          <span aria-hidden className="flex min-w-0 flex-1 items-center gap-1.5">
            <TodoLight status={lead.status} agent={agent} />
            <span className={cn('min-w-0 truncate', lead.status === 'in_progress' && 'font-semibold text-foreground')}>
              {todoText(lead)}
            </span>
          </span>
        )}
        <span aria-hidden data-testid="todo-counts" className="shrink-0 tabular-nums">
          {counts}
        </span>
      </button>
      {open && (
        <ol id={list} className="max-h-48 overflow-y-auto border-t border-border/60 in-data-agent-frame:max-h-32">
          {doneLast(todos).map((todo) => (
            <li
              key={todo.id}
              data-testid="todo-row"
              data-status={todo.status}
              title={todo.content}
              className={cn(LINE, 'flex items-center gap-2 py-1 text-xs pointer-coarse:min-h-9')}
            >
              <TodoLight status={todo.status} agent={agent} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  todo.status === 'completed' && 'text-muted-foreground line-through',
                  todo.status === 'in_progress' && 'font-medium',
                )}
              >
                {todoText(todo)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
})

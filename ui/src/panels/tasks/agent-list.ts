import { agentColorWord, type Task, type TaskDisplayStatus, type TaskListEntry, waitsOnYou } from '@seti/shared'
import { statusLabel } from './status-label'

export const repoLabel = (task: Pick<Task, 'cwd' | 'repos'>) =>
  task.repos.length === 0 ? task.cwd : task.repos.map((repo) => repo.slug).join(', ')

const lastSegment = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

/** The repo names without their owners, or the folder name, for rows too narrow for `repoLabel`. */
export const shortRepoLabel = (task: Pick<Task, 'cwd' | 'repos'>) =>
  task.repos.length === 0 ? lastSegment(task.cwd) : task.repos.map((repo) => lastSegment(repo.slug)).join(', ')

/** An agent as the list shows it: how many of its subagents run and the status they give it. */
export interface AgentRow {
  task: TaskListEntry
  running: number
  status: TaskDisplayStatus
}

function words(row: AgentRow): string {
  const { task, status } = row
  return [
    task.title,
    repoLabel(task),
    status,
    statusLabel(status),
    waitsOnYou(task, status) ? 'needs you' : '',
    task.pinned ? 'pinned' : '',
    task.unseen ? 'unseen' : '',
    agentColorWord(task.color),
  ]
    .join(' ')
    .toLowerCase()
}

/** Agents whose title, repos or folder, status words or colour hold every term of the query. */
export function filterAgents(rows: readonly AgentRow[], query: string): AgentRow[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) {
    return [...rows]
  }
  return rows.filter((row) => {
    const text = words(row)
    return terms.every((term) => text.includes(term))
  })
}

const newestFirst = (a: AgentRow, b: AgentRow) => b.task.updated_at.localeCompare(a.task.updated_at)

/** Agents that wait on the user, newest first, apart from the rest in server order. */
export function groupAgents(rows: readonly AgentRow[]): { needsYou: AgentRow[]; others: AgentRow[] } {
  const waits = (row: AgentRow) => waitsOnYou(row.task, row.status)
  return {
    needsYou: rows.filter(waits).toSorted(newestFirst),
    others: rows.filter((row) => !waits(row)),
  }
}

/** The unseen agent to open next, newest first, other than the one open now; null for none. */
export function nextUnseen(
  tasks: readonly Pick<TaskListEntry, 'id' | 'unseen' | 'updated_at'>[],
  openId: string | null,
): string | null {
  const waiting = tasks.filter((task) => task.unseen && task.id !== openId)
  return waiting.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.id ?? null
}

/** The drag data type of an agent row, which a layout that takes agents accepts. */
export const AGENT_DRAG_TYPE = 'application/x-seti-agent'

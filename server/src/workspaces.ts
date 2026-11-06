import { randomUUID } from 'node:crypto'
import {
  listedStatus,
  type AuditKind,
  type Task,
  type TaskListEntry,
  type Workspace,
  type WorkspaceEntry,
  waitsOnYou,
} from '@seti/shared'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { HttpError } from './http.js'
import { errorCode } from './pg.js'
import { workspaceRows } from './store/workspaces.js'

/** The workspace with this id, or a 404 that says it is gone. */
export async function requireWorkspace(id: string): Promise<Workspace> {
  const workspace = await workspaceRows.get(id)
  if (workspace === undefined) {
    throw new HttpError(404, 'Workspace not found')
  }
  return workspace
}

/** The workspace a request names, or a 400 that says the id is wrong. */
async function namedWorkspace(id: string): Promise<Workspace> {
  const workspace = await workspaceRows.get(id)
  if (workspace === undefined) {
    throw new HttpError(400, 'No workspace with that id')
  }
  return workspace
}

/** Where a new agent goes: the workspace asked for, else the first one. */
export async function startWorkspace(id: string | undefined): Promise<Workspace> {
  if (id !== undefined) {
    return namedWorkspace(id)
  }
  const [first] = await workspaceRows.list()
  if (first === undefined) {
    throw new HttpError(500, 'Seti has no workspace')
  }
  return first
}

/** Each workspace with its agents that are not archived and the ones of those that need the user. */
export function countWorkspaces(list: readonly Workspace[], agents: readonly TaskListEntry[]): WorkspaceEntry[] {
  return list.map((workspace) => {
    const own = agents.filter((task) => task.workspace_id === workspace.id)
    const waiting = own.filter((task) => waitsOnYou(task, listedStatus(task)))
    return { ...workspace, agents: own.length, needs_you: waiting.length }
  })
}

async function record(kind: AuditKind, workspace: Workspace, summary: string, previous?: string): Promise<void> {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'workspace',
    subject_id: workspace.id,
    summary,
    detail: { name: workspace.name, ...(previous === undefined ? {} : { previous_name: previous }) },
  })
}

const nameTaken = (name: string) => new HttpError(409, `A workspace named "${name}" already exists`)

const isUniqueViolation = (e: unknown) => errorCode(e) === '23505'

export async function createWorkspace(name: string): Promise<Workspace> {
  const id = randomUUID()
  try {
    await workspaceRows.insert({ id, name, created_at: now() })
  } catch (e) {
    throw isUniqueViolation(e) ? nameTaken(name) : e
  }
  const workspace = await requireWorkspace(id)
  await record('workspace.created', workspace, `Created workspace "${name}"`)
  return workspace
}

export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  const before = await requireWorkspace(id)
  if (before.name === name) {
    return before
  }
  try {
    await workspaceRows.rename(id, name)
  } catch (e) {
    throw isUniqueViolation(e) ? nameTaken(name) : e
  }
  const after = await requireWorkspace(id)
  await record('workspace.renamed', after, `Renamed workspace "${before.name}" to "${name}"`, before.name)
  return after
}

const agentsWord = (count: number) => (count === 1 ? '1 agent' : `${String(count)} agents`)

/** Deletes an empty workspace; the last one, or one that still holds agents, stays. */
export async function deleteWorkspace(id: string): Promise<void> {
  const workspace = await requireWorkspace(id)
  if ((await workspaceRows.list()).length === 1) {
    throw new HttpError(409, `"${workspace.name}" is the only workspace; Seti keeps at least one`)
  }
  const count = await workspaceRows.agentCount(id)
  if (count > 0) {
    throw new HttpError(
      409,
      `Move or delete the ${agentsWord(count)} in "${workspace.name}" first, archived ones included`,
    )
  }
  await workspaceRows.remove(id)
  await record('workspace.deleted', workspace, `Deleted workspace "${workspace.name}"`)
}

/** Moves an agent, archived or not, to another workspace. */
export async function setTaskWorkspace(task: Task, workspaceId: string): Promise<void> {
  if (task.workspace_id === workspaceId) {
    return
  }
  const target = await namedWorkspace(workspaceId)
  const from = await workspaceRows.get(task.workspace_id)
  await tasks.setWorkspace(task.id, target.id)
  await audit.record({
    actor: 'user',
    kind: 'task.workspace_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Moved task "${task.title}" to workspace "${target.name}"`,
    detail: { title: task.title, workspace: target.name, previous_workspace: from?.name ?? null },
  })
}

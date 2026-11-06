import type { TeamStreamEvent } from '@seti/shared'
import { onShutdown } from '../background.js'
import { onAnyTaskEvent } from '../task-events.js'
import { subscribeTeam } from '../team-events.js'
import { onWorkspaceReleased, onWorkspaceSignal, type WorkspaceArea } from './dir.js'
import { Workspace } from './sync.js'

const CLOSE_GRACE_MS = 30_000

/** Which files a change of platform data touches. */
const AFFECTS: Record<WorkspaceArea, WorkspaceArea[]> = {
  chat: ['chat'],
  members: ['members'],
  packs: ['packs', 'task', 'members'],
  context: ['context'],
  task: ['task'],
}

const open = new Map<string, Workspace>()

/** Renders the task's workspace from the platform's data and starts syncing it. */
export async function openWorkspace(taskId: string): Promise<void> {
  const workspace = open.get(taskId) ?? new Workspace(taskId)
  open.set(taskId, workspace)
  clearTimeout(workspace.closeTimer ?? undefined)
  workspace.closeTimer = null
  await workspace.flush()
  await workspace.run(async () => workspace.renderAll())
}

async function closeWorkspace(taskId: string): Promise<void> {
  const workspace = open.get(taskId)
  if (workspace !== undefined) {
    open.delete(taskId)
    await workspace.close()
  }
}

async function closeAllWorkspaces(): Promise<void> {
  for (const taskId of open.keys()) {
    await closeWorkspace(taskId)
  }
}

onShutdown(closeAllWorkspaces)

/** Stops syncing a while after the session closed; edits made meanwhile still apply. */
function closeWorkspaceSoon(taskId: string): void {
  const workspace = open.get(taskId)
  if (workspace === undefined) {
    return
  }
  clearTimeout(workspace.closeTimer ?? undefined)
  workspace.closeTimer = setTimeout(() => {
    void closeWorkspace(taskId)
  }, CLOSE_GRACE_MS)
  workspace.closeTimer.unref()
}

function refreshOpen(area: WorkspaceArea, taskId: string | null): void {
  for (const workspace of open.values()) {
    if (taskId === null || workspace.taskId === taskId) {
      workspace.requestRefresh(AFFECTS[area])
    }
  }
}

function onTeamEvent(event: TeamStreamEvent): void {
  if (event.type === 'message') {
    refreshOpen('chat', null)
  } else {
    refreshOpen('members', null)
    refreshOpen('chat', event.member.task_id)
  }
}

/** Keeps open workspaces live: platform changes and chat traffic refresh them. */
export function startWorkspaceSync(): void {
  onWorkspaceSignal(refreshOpen)
  onWorkspaceReleased(closeWorkspace)
  subscribeTeam(onTeamEvent)
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'session' && !event.session.open) {
      closeWorkspaceSoon(taskId)
    }
  })
}

/** A turn that ended changes what its agent works on and may have changed the task. */
export function workspaceTurnEnded(taskId: string): void {
  refreshOpen('members', null)
  refreshOpen('task', taskId)
}

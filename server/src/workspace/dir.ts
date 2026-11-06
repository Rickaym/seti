import path from 'node:path'
import { SETI_HOME } from '../config.js'

/** Names the task's workspace folder in its agent's environment. */
export const WORKSPACE_ENV = 'SETI_WORKSPACE'

export const WORKSPACE_ROOT = path.join(SETI_HOME, 'workspace')

export const workspaceDir = (taskId: string) => path.join(WORKSPACE_ROOT, taskId)

export const CHAT = 'chat.md'
export const MEMBERS = 'members.md'
export const TASK = 'task.md'
export const PACKS = 'packs'
export const CONTEXT = 'context'

/** What Seti writes at the top of each workspace from its data; the rest is the agent's. */
export const SETI_FILES: readonly string[] = [CHAT, MEMBERS, TASK, PACKS, CONTEXT]

/** Platform data a workspace mirrors; a change refreshes every open workspace that shows it. */
export type WorkspaceArea = 'chat' | 'members' | 'packs' | 'context' | 'task'

type SignalListener = (area: WorkspaceArea, taskId: string | null) => void

const signalListeners: SignalListener[] = []
const removeListeners: ((taskId: string) => Promise<void>)[] = []

export function onWorkspaceSignal(listener: SignalListener): void {
  signalListeners.push(listener)
}

/** Tells open workspaces that data changed outside them; taskId narrows it to one task. */
export function signalWorkspaces(area: WorkspaceArea, taskId: string | null = null): void {
  for (const listener of signalListeners) {
    listener(area, taskId)
  }
}

export function onWorkspaceReleased(listener: (taskId: string) => Promise<void>): void {
  removeListeners.push(listener)
}

/** Stops syncing a task's workspace before its folder is packed or removed. */
export async function releaseWorkspace(taskId: string): Promise<void> {
  for (const listener of removeListeners) {
    await listener(taskId)
  }
}

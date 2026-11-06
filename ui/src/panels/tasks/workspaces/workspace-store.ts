import { listedStatus, waitsOnYou, type TaskListEntry, type Workspace } from '@seti/shared'
import { useSyncExternalStore } from 'react'

export const WORKSPACE_KEY = 'seti.workspace'

function readChosen(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null
  }
}

let chosen = readChosen()
let followed: string | null = null
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) {
    listener()
  }
}

/** The workspace this device last chose, which may since have been deleted. */
export const chosenWorkspace = (): string | null => chosen

/** Shows `id` on this device from now on. */
export function chooseWorkspace(id: string): void {
  if (id === chosen) {
    return
  }
  chosen = id
  try {
    localStorage.setItem(WORKSPACE_KEY, id)
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
  notify()
}

/** The open agent the list last went along with, as `<id>/<workspace id>`. */
const followedAgent = (): string | null => followed

/** Records the open agent the list went along with, and shows its workspace when given. */
export function followAgent(key: string | null, workspaceId: string | null): void {
  if (workspaceId !== null) {
    chooseWorkspace(workspaceId)
  }
  if (key !== followed) {
    followed = key
    notify()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useChosenWorkspace = (): string | null => useSyncExternalStore(subscribe, chosenWorkspace)

export const useFollowedAgent = (): string | null => useSyncExternalStore(subscribe, followedAgent)

/** The chosen workspace while it exists, else the first one. */
export function resolveWorkspace<T extends Pick<Workspace, 'id'>>(list: readonly T[], id: string | null): T | null {
  return list.find((workspace) => workspace.id === id) ?? list[0] ?? null
}

const waiting = (tasks: readonly TaskListEntry[]) => tasks.filter((task) => waitsOnYou(task, listedStatus(task)))

/** How many agents need the user in each workspace that has any. */
export function needsYouByWorkspace(tasks: readonly TaskListEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of waiting(tasks)) {
    counts.set(task.workspace_id, (counts.get(task.workspace_id) ?? 0) + 1)
  }
  return counts
}

/** Where the Needs you group has agents: this workspace when it does, else the newest failure's. */
export function needsYouWorkspace(tasks: readonly TaskListEntry[], current: string | null): string | null {
  const list = waiting(tasks)
  if (list.some((task) => task.workspace_id === current)) {
    return current
  }
  const newest = list.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  return newest?.workspace_id ?? current
}

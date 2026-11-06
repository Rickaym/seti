import { taskListSchema, type ArchivedTaskEntry, type TaskListEntry } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const NO_TASKS: readonly TaskListEntry[] = []
const NO_ARCHIVED: readonly ArchivedTaskEntry[] = []

const tasksResource = createPolledResource('/tasks', 5000, { schema: taskListSchema })
const archivedResource = createPolledResource<ArchivedTaskEntry[]>('/tasks/archived', 15_000)

/** Task list shared by every consumer; `refresh` refetches now, `loaded` tells empty from loading. */
export function useTasks() {
  const { data, error } = usePolled(tasksResource)
  return { tasks: data ?? NO_TASKS, loaded: data !== undefined, error, refresh: tasksResource.refresh }
}

/** Archived agents, polled less often; `loaded` tells an empty list from one still loading. */
export function useArchivedTasks() {
  const { data } = usePolled(archivedResource)
  return { archived: data ?? NO_ARCHIVED, loaded: data !== undefined }
}

/** Refetches the task list now, without subscribing to it. */
export const refreshTasks = (): void => {
  tasksResource.refresh()
}

/** Refetches both lists, after an agent is archived or restored. */
export function refreshTaskLists(): void {
  tasksResource.refresh()
  archivedResource.refresh()
}

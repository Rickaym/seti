import { displayStatus, prStates, runningSubtasks, waitsOnYou, type Task } from '@seti/shared'
import { tasks } from './db.js'
import { openQuerySince } from './runner.js'
import { prWatch } from './store/pr-watch.js'
import { subtaskBriefs } from './subtask-cache.js'

/** The agents that wait on the user, as the status bar counts them, most recently updated first. */
export async function needsYouTasks(): Promise<Task[]> {
  const [list, states] = await Promise.all([tasks.list(), prWatch.allTaskStates()])
  const waiting = await Promise.all(
    list.map(async (task) => {
      const subtasks = await subtaskBriefs(task.id, openQuerySince(task.id))
      const shown = displayStatus(task, prStates(states.get(task.id) ?? {}), runningSubtasks(subtasks))
      return waitsOnYou(task, shown)
    }),
  )
  return list.filter((_task, index) => waiting[index] === true)
}

/** How many agents wait on the user, counted as the status bar counts them. */
export async function needsYouCount(): Promise<number> {
  return (await needsYouTasks()).length
}

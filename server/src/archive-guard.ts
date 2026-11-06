import { archivedRefusal, type Task } from '@seti/shared'
import { HttpError } from './http.js'

/** Refuses work for an archived task, from any path that would give it some. */
export function refuseArchived(task: Pick<Task, 'title' | 'archived_at'>): void {
  if (task.archived_at !== null) {
    throw new HttpError(409, archivedRefusal(task.title))
  }
}

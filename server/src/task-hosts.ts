import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { taskHosts } from './store/change-requests.js'

/** Adds an allowlist entry for one agent alone; its proxy lets it through from the next request. */
export async function allowTaskHost(task: Task, entry: string): Promise<void> {
  refuseAgent("change an agent's network allowlist")
  if (await taskHosts.add(task.id, entry)) {
    await audit.record({
      actor: 'user',
      kind: 'task.host_allowed',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Let task "${task.title}" reach ${entry}`,
      detail: { title: task.title, entry },
    })
  }
}

/** Takes an entry off one agent's own allowlist. */
export async function removeTaskHost(task: Task, entry: string): Promise<string[]> {
  refuseAgent("change an agent's network allowlist")
  if (!(await taskHosts.remove(task.id, entry))) {
    throw new HttpError(404, `${task.title} has no host ${entry} of its own`)
  }
  await audit.record({
    actor: 'user',
    kind: 'task.host_removed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Stopped task "${task.title}" reaching ${entry}`,
    detail: { title: task.title, entry },
  })
  return taskHosts.list(task.id)
}

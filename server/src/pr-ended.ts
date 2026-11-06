import { auditPrLink } from './audit.js'
import { tasks } from './db.js'
import { openQuerySince, publish } from './runner.js'
import { prDismissals } from './store/pr-discovery.js'
import { prWatch, type EndedLink } from './store/pr-watch.js'
import { publishSubtasks } from './subtask-prs.js'

async function unlinkEnded(link: EndedLink): Promise<boolean> {
  if (!(await tasks.unlinkPr(link.task_id, link.pr_url))) {
    return false
  }
  await prDismissals.add(link.task_id, link.pr_url)
  const merged = link.state === 'merged'
  const reason = merged ? 'it merged' : 'it closed'
  await auditPrLink({ actor: 'system', taskId: link.task_id, url: link.pr_url, linked: false, reason, merged })
  return true
}

/**
 * Unlinks every PR GitHub reported merged or closed from each task and subagent it was linked
 * to, and keeps Seti from linking it again on its own; a reopened PR returns only when someone
 * links it. Returns the ids of the tasks that changed.
 */
export async function unlinkEndedPrs(): Promise<string[]> {
  const changed = new Map<string, boolean>()
  for (const link of await prWatch.endedLinks()) {
    if (await unlinkEnded(link)) {
      changed.set(link.task_id, (changed.get(link.task_id) ?? false) || link.tool_use_id !== null)
    }
  }
  for (const [taskId, subtasks] of changed) {
    publish(taskId, { type: 'prs' })
    if (subtasks) {
      await publishSubtasks(taskId, openQuerySince(taskId))
    }
  }
  return [...changed.keys()]
}

import type { Task, TaskAccessView } from '@seti/shared'
import { effectiveAccess, storeOverride } from './agent-access.js'
import { audit } from './audit.js'
import { refuseDelegates } from './ea-guard.js'
import { sshKeysChanged } from './proxy-owner.js'
import { signalWorkspaces } from './workspace/dir.js'

/**
 * Drops every own choice of an agent, so each item follows its credential, else the default, from
 * its next turn. Only the user does it: it can lift what an agent-started agent was held to.
 */
export async function resetTaskAccess(task: Task): Promise<TaskAccessView> {
  refuseDelegates("reset an agent's access")
  const view = await effectiveAccess(task)
  const own = view.items.filter((item) => item.override !== null)
  if (own.length === 0) {
    return view
  }
  for (const item of own) {
    await storeOverride(task, item.kind, item.id, null)
  }
  await audit.record({
    actor: 'user',
    kind: 'task.access_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Reset ${String(own.length)} own access choices of task "${task.title}" to ${view.profile.name} and the defaults`,
    detail: {
      title: task.title,
      change: 'reset_all',
      profile: view.profile.name,
      own_on: own.filter((item) => item.override === true).map((item) => `${item.kind}:${item.id}`),
      own_off: own.filter((item) => item.override === false).map((item) => `${item.kind}:${item.id}`),
    },
  })
  signalWorkspaces('task', task.id)
  if (own.some((item) => item.kind === 'ssh')) {
    await sshKeysChanged()
  }
  return effectiveAccess(task)
}

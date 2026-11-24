import { DELEGATE_LIMITS } from '@seti/shared'
import { tasks } from '../db.js'
import { HttpError } from '../http.js'
import { delegates } from '../store/delegates.js'

const DAY_MS = 24 * 60 * 60 * 1000

const refuse = (reason: string) => new HttpError(409, reason)

/**
 * Refuses an agent's start of another agent past the limits: none by an agent another agent
 * started, `running` running per caller and `install` in all, and `budgetUsd` a day per caller.
 */
export async function checkDelegateLimits(callerId: string): Promise<void> {
  const caller = await tasks.get(callerId)
  if (caller !== undefined && caller.delegated_by !== null) {
    throw refuse('Another agent started you, so you cannot start agents; do the work yourself or ask the user')
  }
  const { running, install, budgetUsd } = DELEGATE_LIMITS
  if ((await delegates.running(callerId)) >= running) {
    throw refuse(`You have ${String(running)} agents running already; wait for one to end`)
  }
  if ((await delegates.running(null)) >= install) {
    throw refuse(`${String(install)} agents that agents started are running on this Seti; wait for one to end`)
  }
  const since = new Date(Date.now() - DAY_MS).toISOString()
  if ((await delegates.costSince(callerId, since)) >= budgetUsd) {
    throw refuse(`The agents you started in the last 24 hours have cost $${String(budgetUsd)} or more`)
  }
}

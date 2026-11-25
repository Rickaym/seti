import { DELEGATE_LIMITS } from '@seti/shared'
import { tasks } from '../db.js'
import { HttpError } from '../http.js'
import { delegates } from '../store/delegates.js'

const DAY_MS = 24 * 60 * 60 * 1000

const refuse = (reason: string) => new HttpError(409, reason)

/** Starts under way, by caller, which count as running until they return. */
const starting = new Map<string, number>()
let checks: Promise<unknown> = Promise.resolve()

const startingFor = (callerId: string | null) =>
  callerId === null ? [...starting.values()].reduce((sum, n) => sum + n, 0) : (starting.get(callerId) ?? 0)

const runningFor = async (callerId: string | null) => (await delegates.running(callerId)) + startingFor(callerId)

/**
 * Refuses an agent's start of another agent past the limits: none by an agent another agent
 * started, `running` running per caller and `install` in all, and `budgetUsd` a day per caller.
 */
async function checkDelegateLimits(callerId: string): Promise<void> {
  const caller = await tasks.get(callerId)
  if (caller !== undefined && caller.delegated_by !== null) {
    throw refuse('Another agent started you, so you cannot start agents; do the work yourself or ask the user')
  }
  const { running, install, budgetUsd } = DELEGATE_LIMITS
  if ((await runningFor(callerId)) >= running) {
    throw refuse(`You have ${String(running)} agents running already; wait for one to end`)
  }
  if ((await runningFor(null)) >= install) {
    throw refuse(`${String(install)} agents that agents started are running on this Seti; wait for one to end`)
  }
  const since = new Date(Date.now() - DAY_MS).toISOString()
  if ((await delegates.costSince(callerId, since)) >= budgetUsd) {
    throw refuse(`The agents you started in the last 24 hours have cost $${String(budgetUsd)} or more`)
  }
}

/**
 * Checks the limits one start at a time and counts this start as running until `start` returns,
 * so calls made at once cannot all pass the same count.
 */
export async function withinDelegateLimits<T>(callerId: string, start: () => Promise<T>): Promise<T> {
  const checked = checks.then(async () => {
    await checkDelegateLimits(callerId)
    starting.set(callerId, startingFor(callerId) + 1)
  })
  checks = checked.catch(() => undefined)
  await checked
  try {
    return await start()
  } finally {
    const left = startingFor(callerId) - 1
    if (left > 0) {
      starting.set(callerId, left)
    } else {
      starting.delete(callerId)
    }
  }
}

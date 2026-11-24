import type { ModDreamsApi } from '@seti/mod-api'
import { dreamNight } from '../dreams/nights.js'
import { startDream } from '../dreams/start.js'
import { dreamSettings } from '../store/dream-nights.js'
import { dreamProposals } from '../store/dream-proposals.js'
import { dreamRuns } from '../store/dreams.js'
import { requireTask } from '../tasks.js'
import { requireOp } from './capabilities.js'

type Run = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * The tasks.dream capability: nights of dreams, the clean-ups that wait for the user, and a
 * dream started now. Starts run as the mod, so core's caps and its one dream a day hold.
 */
export function dreamApi(run: Run): ModDreamsApi {
  const granted = async <T>(fn: () => Promise<T>) =>
    run(async () => {
      requireOp('tasks.dream')
      return fn()
    })
  return {
    night: async (name) => granted(async () => dreamNight(name)),
    shown: async () => granted(async () => (await dreamSettings.get()).enabled || (await dreamRuns.any())),
    proposals: async () => granted(async () => dreamProposals.pending()),
    start: async (task) => granted(async () => startDream(await requireTask(task))),
  }
}

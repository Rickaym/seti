import type { AttentionBriefLine, DreamRun } from '@seti/shared'
import { dreamNights, nightRuns } from '../store/dream-nights.js'

/** Where a tap on the night's line opens Seti: the Dreaming mod's Dreams view. */
const DREAMS_URL = '/#dreaming.dreams'

const plural = (count: number, one: string, many = `${one}s`) => `${String(count)} ${count === 1 ? one : many}`

/** The night in a few words, such as "6 agents dreamt, 2 want you, $1.40". */
export function nightLine(runs: readonly DreamRun[]): string {
  const nightly = runs.filter((run) => run.kind === 'nightly')
  const dreamt = nightly.filter((run) => run.state === 'done' || run.state === 'stopped')
  if (nightly.length > 0 && nightly.every((run) => run.state === 'failed')) {
    return `Every dream failed (${plural(nightly.length, 'agent')})`
  }
  if (dreamt.length === 0) {
    return 'No agent had anything new to tidy'
  }
  const asking = dreamt.filter((run) => (run.report?.asks.length ?? 0) > 0).length
  const cost = runs.reduce((sum, run) => sum + run.cost_usd, 0)
  const parts = [`${plural(dreamt.length, 'agent')} dreamt`, ...(asking > 0 ? [`${String(asking)} want you`] : [])]
  return `${parts.join(', ')}, $${cost.toFixed(2)}`
}

/**
 * One line per night whose window ended between two instants, for the brief's changes: never
 * a reason an agent needs the user, and nothing at night pushes it.
 */
export async function dreamBriefLines(since: string, at: string): Promise<AttentionBriefLine[]> {
  const nights = await dreamNights.endedBetween(since, at)
  return Promise.all(
    nights.map(async (night) => ({
      task_id: null,
      title: 'Dreams',
      text: nightLine(await nightRuns.of(night.night)),
      url: DREAMS_URL,
    })),
  )
}

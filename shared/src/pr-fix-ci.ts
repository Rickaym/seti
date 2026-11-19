import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'
import type { LinkedTask, PrRow } from './prs.js'
import { TASK_STATUSES } from './tasks.js'

/** A PR as the Fix CI message names it. */
export type FixCiPr = Pick<PrRow, 'repo_slug' | 'number'>

/** One agent and the short message that asks it to fix CI on its own failing PRs. */
export interface FixCiNudge {
  task: LinkedTask
  prs: FixCiPr[]
  message: string
}

/** Why an agent with failing PRs gets no message. */
export type FixCiSkipReason = 'archived' | 'stopped'

export interface FixCiSkip {
  task: LinkedTask
  reason: FixCiSkipReason
}

/** Who Fix CI asks about which open PRs with failing CI, and what it leaves out. */
export interface FixCiPlan {
  nudges: FixCiNudge[]
  /** Agents linked to a failing PR that take no message as they stand. */
  skipped: FixCiSkip[]
  /** Failing PRs with no agent linked, which nobody is asked about. */
  unlinked: number
  /** Why GitHub gave no PR list, so the plan may miss PRs; null when it answered. */
  error: string | null
}

/** Limits the plan to one agent, by id. */
export const fixCiQuery = z.object({ task: z.string().trim().min(1).max(100).optional() })

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`

const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const inOrder = (a: FixCiPr, b: FixCiPr) => {
  const byRepo = a.repo_slug.toLowerCase().localeCompare(b.repo_slug.toLowerCase(), 'en')
  return byRepo === 0 ? a.number - b.number : byRepo
}

/** The PRs once each, by repo and number. */
function distinct(prs: readonly FixCiPr[]): FixCiPr[] {
  const seen = new Map(prs.map((pr) => [`${pr.repo_slug.toLowerCase()}#${String(pr.number)}`, pr]))
  return [...seen.values()].sort(inOrder)
}

/**
 * The whole Fix CI message: the failing PRs by number, with the repo when they span several, and
 * nothing else, since the agent reads the checks itself.
 */
export function fixCiNudge(failing: readonly FixCiPr[]): string {
  const prs = distinct(failing)
  const [first] = prs
  const oneRepo = first !== undefined && prs.every((pr) => sameRepo(pr.repo_slug, first.repo_slug))
  const names = prs.map((pr) => `${oneRepo ? '' : pr.repo_slug}#${String(pr.number)}`)
  return `CI is failing on ${listed(names)}. Please fix ${prs.length === 1 ? 'it' : 'them'}.`
}

const skipReason = (task: LinkedTask, archived: ReadonlySet<string>): FixCiSkipReason | null => {
  if (archived.has(task.id)) {
    return 'archived'
  }
  return task.status === 'stopped' ? 'stopped' : null
}

/**
 * Groups the open PRs with failing CI by linked agent, one message each. Archived and stopped
 * agents are skipped, and with `only` the plan covers that agent alone.
 */
export function planFixCi(
  rows: readonly PrRow[],
  archived: ReadonlySet<string>,
  only?: string,
): Omit<FixCiPlan, 'error'> {
  const byTask = new Map<string, { task: LinkedTask; prs: FixCiPr[] }>()
  let unlinked = 0
  for (const row of rows.filter((pr) => pr.ci === 'failure')) {
    const tasks = row.tasks.filter((task) => only === undefined || task.id === only)
    if (row.tasks.length === 0 && only === undefined) {
      unlinked += 1
    }
    for (const task of tasks) {
      const entry = byTask.get(task.id) ?? { task, prs: [] }
      entry.prs.push({ repo_slug: row.repo_slug, number: row.number })
      byTask.set(task.id, entry)
    }
  }
  const nudges: FixCiNudge[] = []
  const skipped: FixCiSkip[] = []
  for (const { task, prs } of byTask.values()) {
    const reason = skipReason(task, archived)
    if (reason === null) {
      nudges.push({ task, prs: distinct(prs), message: fixCiNudge(prs) })
    } else {
      skipped.push({ task, reason })
    }
  }
  return { nudges, skipped, unlinked }
}

/** How many distinct PRs the plan's messages name. */
export function fixCiPrCount({ nudges }: Pick<FixCiPlan, 'nudges'>): number {
  const keys = nudges.flatMap(({ prs }) => prs.map((pr) => `${pr.repo_slug.toLowerCase()}#${String(pr.number)}`))
  return new Set(keys).size
}

/** `3 agents about 5 PRs`: what sending the plan reaches. */
export const fixCiReach = (plan: Pick<FixCiPlan, 'nudges'>) =>
  `${plural(plan.nudges.length, 'agent', 'agents')} about ${plural(fixCiPrCount(plan), 'PR', 'PRs')}`

/** What the plan leaves out, as sentences; empty when it covers every failing PR. */
export function fixCiSkipped({ skipped, unlinked }: Pick<FixCiPlan, 'skipped' | 'unlinked'>): string {
  const agents = skipped.map(({ task, reason }) => `${task.title} (${reason})`)
  return [
    agents.length > 0 ? `Skipped ${listed(agents)}.` : '',
    unlinked > 0 ? `Skipped ${plural(unlinked, 'failing PR', 'failing PRs')} with no agent.` : '',
  ]
    .filter((line) => line !== '')
    .join(' ')
}

const linkedTask = z.object({ id: z.string(), title: z.string(), status: z.enum(TASK_STATUSES) })

export const fixCiPlanSchema = z.object({
  nudges: lenientArray(
    'fix ci nudge',
    z.object({
      task: linkedTask,
      prs: z.array(z.object({ repo_slug: z.string(), number: z.number() })),
      message: z.string(),
    }),
  ),
  skipped: lenientArray('fix ci skip', z.object({ task: linkedTask, reason: z.enum(['archived', 'stopped']) })),
  unlinked: orDefault('unlinked', z.number().int().nonnegative(), 0),
  error: orDefault('fix ci error', z.string().nullable(), null),
}) satisfies ResponseSchema<FixCiPlan>

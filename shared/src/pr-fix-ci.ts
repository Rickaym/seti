import { z } from 'zod'
import type { LinkedTask, PrRow } from './prs.js'

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

import type { CiState, PrCheck } from '@seti/shared'
import { z } from 'zod'

/** The statusCheckRollup both PR queries select, with each check's workflow run. */
export const ROLLUP_FIELDS = `statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { databaseId workflow { name } } } }
      ... on StatusContext { context state targetUrl }
    } }
  }`

const checkContext = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    checkSuite: z
      .object({
        workflowRun: z.object({ databaseId: z.number(), workflow: z.object({ name: z.string() }) }).nullable(),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable(),
  }),
])
type GhCheck = z.infer<typeof checkContext>

export const statusCheckRollup = z
  .object({ state: z.string(), contexts: z.object({ nodes: z.array(checkContext) }) })
  .nullable()
type GhRollup = z.infer<typeof statusCheckRollup>

function ciState(state: string): CiState {
  switch (state.toUpperCase()) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'CANCELLED':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failure'
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'neutral'
    default:
      return 'pending'
  }
}

function toCheck(check: GhCheck): PrCheck {
  if (check.__typename === 'StatusContext') {
    return { name: check.context, state: ciState(check.state), detail: check.state.toLowerCase(), url: check.targetUrl }
  }
  const outcome = check.conclusion ?? check.status
  return { name: check.name, state: ciState(outcome), detail: outcome.toLowerCase(), url: check.detailsUrl }
}

const workflowOf = (check: GhCheck) =>
  check.__typename === 'CheckRun' ? (check.checkSuite?.workflowRun ?? null) : null

/** Drops checks of workflow runs that a newer run of the same workflow replaced on this commit. */
function current(checks: readonly GhCheck[]): GhCheck[] {
  const newest = new Map<string, number>()
  for (const check of checks) {
    const run = workflowOf(check)
    if (run !== null && run.databaseId > (newest.get(run.workflow.name) ?? -1)) {
      newest.set(run.workflow.name, run.databaseId)
    }
  }
  return checks.filter((check) => {
    const run = workflowOf(check)
    return run === null || run.databaseId === newest.get(run.workflow.name)
  })
}

function summary(checks: readonly PrCheck[]): CiState {
  const states = new Set(checks.map((check) => check.state))
  if (states.has('failure')) {
    return 'failure'
  }
  if (states.has('pending')) {
    return 'pending'
  }
  return states.has('success') ? 'success' : 'neutral'
}

/** The commit's checks and overall state, ignoring runs a newer run of their workflow superseded. */
export function readRollup(rollup: GhRollup): { ci: CiState | null; checks: PrCheck[] } {
  if (rollup === null) {
    return { ci: null, checks: [] }
  }
  const checks = current(rollup.contexts.nodes).map(toCheck)
  return { ci: checks.length === 0 ? ciState(rollup.state) : summary(checks), checks }
}

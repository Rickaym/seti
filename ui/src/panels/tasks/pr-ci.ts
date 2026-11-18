import type { PrCheck, PullRequest } from '@seti/shared'

/** A PR that cannot merge as it stands: CI failed or it conflicts with its base. */
export const needsFix = (pr: Pick<PullRequest, 'ci' | 'mergeable'>) =>
  pr.ci === 'failure' || pr.mergeable === 'conflicting'

const OUTCOME: Partial<Record<string, string>> = {
  failure: 'failed',
  error: 'errored',
  timed_out: 'timed out',
  cancelled: 'cancelled',
  action_required: 'needs action',
  startup_failure: 'failed to start',
}

/** How a check ended in words, from the GitHub conclusion Seti keeps as its detail. */
export const checkOutcome = (check: Pick<PrCheck, 'detail'>) =>
  OUTCOME[check.detail] ?? check.detail.replaceAll('_', ' ')

export const failingChecks = (pr: Pick<PullRequest, 'checks'>) => pr.checks.filter((check) => check.state === 'failure')

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

/** The message that asks a PR's own agent to fix its failing checks, with each check's outcome. */
export function fixCiMessage(pr: PullRequest): string {
  const failing = failingChecks(pr).map((check) => {
    const log = check.url === null ? '' : ` (${check.url})`
    return `- ${check.name}: ${checkOutcome(check)}${log}`
  })
  const number = String(pr.number)
  return [
    `CI is failing on your pull request #${number} in ${pr.repo_slug}: ${pr.title}`,
    pr.url,
    `Commit ${pr.head_oid.slice(0, 7)} on ${pr.head_ref}`,
    ...(failing.length > 0 ? ['', 'Failing checks:', ...failing] : []),
    '',
    `Read the logs of the failing checks (gh pr checks ${number} -R ${pr.repo_slug}, then gh run view --log-failed), find the cause and fix it.`,
    `Run the same checks locally where you can, then push to the PR branch ${pr.head_ref}.`,
  ].join('\n')
}

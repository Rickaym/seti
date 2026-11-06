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

/** The start prompt for an agent that fixes the PR's failing checks, with each check's outcome. */
export function fixCiPrompt(pr: PullRequest): string {
  const failing = failingChecks(pr).map((check) => {
    const log = check.url === null ? '' : ` (${check.url})`
    return `- ${check.name}: ${checkOutcome(check)}${log}`
  })
  const commit = pr.head_oid.slice(0, 7)
  return [
    `Fix the failing CI on pull request #${String(pr.number)} in ${pr.repo_slug}: ${pr.title}`,
    pr.url,
    '',
    `You are in an isolated worktree checked out at origin/${pr.head_ref} (detached HEAD).`,
    `The PR merges ${pr.head_ref} into ${pr.base_ref}.`,
    `Commit your changes and push them to the PR branch with: git push origin HEAD:${pr.head_ref}`,
    ...(failing.length > 0 ? ['', `Failing checks on ${commit}:`, ...failing] : []),
    '',
    `Task: Read the logs of the failing checks (gh pr checks ${String(pr.number)} -R ${pr.repo_slug}, then gh run view --log-failed), find the cause, fix it, run the same checks locally where you can, and push.`,
  ].join('\n')
}

import type { PrCheck, PullRequest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { checkOutcome, fixCiMessage, needsFix } from './pr-ci'

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    key: `web-${String(number)}`,
    repo_id: 'e2e/web',
    repo_slug: 'e2e/web',
    number,
    title: `change ${String(number)}`,
    url: `https://github.com/e2e/web/pull/${String(number)}`,
    draft: false,
    author: 'e2e',
    head_ref: `feat/${String(number)}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: '2026-10-03T10:00:00Z',
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
    ...over,
  }
}

const check = (name: string, state: PrCheck['state'], detail: string, url: string | null = null): PrCheck => ({
  name,
  state,
  detail,
  url,
})

describe('needsFix', () => {
  it('flags failing CI and merge conflicts only', () => {
    expect(needsFix(pr(1, { ci: 'failure' }))).toBe(true)
    expect(needsFix(pr(2, { mergeable: 'conflicting' }))).toBe(true)
    expect(needsFix(pr(3, { ci: 'pending', mergeable: 'unknown' }))).toBe(false)
  })
})

describe('checkOutcome', () => {
  it('says how a check ended in words', () => {
    expect(checkOutcome(check('build', 'failure', 'failure'))).toBe('failed')
    expect(checkOutcome(check('e2e', 'failure', 'timed_out'))).toBe('timed out')
    expect(checkOutcome(check('deploy', 'failure', 'some_new_state'))).toBe('some new state')
  })
})

describe('fixCiMessage', () => {
  const failing = pr(42, {
    ci: 'failure',
    checks: [
      check('lint', 'success', 'success'),
      check('build', 'failure', 'failure', 'https://github.com/e2e/web/runs/1'),
      check('e2e', 'failure', 'timed_out'),
    ],
  })

  it('names the PR, its commit and each failing check with its outcome and log', () => {
    const message = fixCiMessage(failing)
    expect(message.split('\n').slice(0, 7)).toEqual([
      'CI is failing on your pull request #42 in e2e/web: change 42',
      'https://github.com/e2e/web/pull/42',
      'Commit abc1234 on feat/42',
      '',
      'Failing checks:',
      '- build: failed (https://github.com/e2e/web/runs/1)',
      '- e2e: timed out',
    ])
    expect(message).not.toContain('lint')
  })

  it('asks the agent to read the logs, fix the cause, check locally and push to the PR branch', () => {
    const message = fixCiMessage(failing)
    expect(message).toContain('gh pr checks 42 -R e2e/web, then gh run view --log-failed')
    expect(message).toContain('find the cause and fix it')
    expect(message).toContain('Run the same checks locally where you can, then push to the PR branch feat/42.')
    expect(message).not.toContain('worktree')
  })

  it('leaves the check list out when no check failed', () => {
    const message = fixCiMessage(pr(7, { ci: 'failure' }))
    expect(message).not.toContain('Failing checks:')
    expect(message).toContain('Commit abc1234 on feat/7')
  })
})

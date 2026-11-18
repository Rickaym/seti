import type { PrCheck, PullRequest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { checkOutcome, needsFix } from './pr-ci'

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    key: `web-${String(number)}`,
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

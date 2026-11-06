import type { LinkedTask } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { OpenPr } from './github.js'
import { relatePrs } from './pr-graph.js'
import type { PrRef } from './pr-refs.js'

interface Spec {
  number: number
  head?: string
  base?: string
  refs?: PrRef[]
}

function pr(slug: string, spec: Spec): OpenPr {
  const name = slug.split('/').at(-1) ?? slug
  return {
    key: `${name}-${String(spec.number)}`,
    repo_id: slug,
    repo_slug: slug,
    number: spec.number,
    title: `${name} ${String(spec.number)}`,
    url: `https://github.com/${slug}/pull/${String(spec.number)}`,
    draft: false,
    author: 'octocat',
    head_ref: spec.head ?? `feat/${name}-${String(spec.number)}`,
    base_ref: spec.base ?? 'dev',
    head_oid: 'abc',
    updated_at: '2026-09-20T00:00:00Z',
    review_decision: null,
    mergeable: 'unknown',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    refs: spec.refs ?? [],
  }
}

const ref = (slug: string, number: number, place: PrRef['place'] = 'body', pull = false): PrRef => ({
  slug,
  number,
  place,
  pull,
})

const API = 'acme/api'
const WEB = 'acme/web'
const NONE = new Map<string, LinkedTask[]>()

describe('relatePrs', () => {
  it('relates mentions both ways across repos and only when they name an open PR', () => {
    const prs = [
      pr(WEB, { number: 1, refs: [ref(API, 2), ref(WEB, 99), ref('Acme/API', 3, 'comment')] }),
      pr(API, { number: 2 }),
      pr(API, { number: 3 }),
    ]
    const related = relatePrs(prs, NONE)
    expect(related.get(prs[0]?.url ?? '')).toEqual([
      {
        url: 'https://github.com/acme/api/pull/2',
        key: 'api-2',
        label: 'api#2',
        title: 'api 2',
        ci: 'success',
        reasons: [{ type: 'mentions', place: 'body' }],
      },
      expect.objectContaining({ key: 'api-3', reasons: [{ type: 'mentions', place: 'comment' }] }),
    ])
    expect(related.get(prs[1]?.url ?? '')).toEqual([
      expect.objectContaining({ key: 'web-1', reasons: [{ type: 'mentioned_by', place: 'body' }] }),
    ])
  })

  it('keeps PR URLs outside the open PRs as links out, but not bare numbers that may be issues', () => {
    const prs = [pr(WEB, { number: 1, refs: [ref('other/lib', 5, 'body', true), ref('other/lib', 6), ref(WEB, 7)] })]
    expect(relatePrs(prs, NONE).get(prs[0]?.url ?? '')).toEqual([
      {
        url: 'https://github.com/other/lib/pull/5',
        key: null,
        label: 'other/lib#5',
        title: null,
        ci: null,
        reasons: [{ type: 'mentions', place: 'body' }],
      },
    ])
  })

  it('relates PRs of the same task, with closed ones as links out', () => {
    const prs = [pr(WEB, { number: 1 }), pr(API, { number: 2 })]
    const task = { id: 't1', title: 'Ship login', status: 'idle' as const }
    const tasks = new Map([
      [prs[0]?.url ?? '', [task]],
      [prs[1]?.url ?? '', [task]],
      ['https://github.com/acme/api/pull/1', [task]],
    ])
    const reason = { type: 'same_task', task_id: 't1', task_title: 'Ship login' }
    expect(relatePrs(prs, tasks).get(prs[0]?.url ?? '')).toEqual([
      expect.objectContaining({ key: 'api-2', reasons: [reason] }),
      expect.objectContaining({ key: null, label: 'acme/api#1', reasons: [reason] }),
    ])
  })

  it('relates PRs on the same feature branch but not on long-lived branches', () => {
    const prs = [
      pr(WEB, { number: 1, head: 'feat/login' }),
      pr(API, { number: 2, head: 'feat/login' }),
      pr(API, { number: 3, head: 'feat/login', base: 'onprem' }),
      pr(WEB, { number: 4, head: 'dev', base: 'main' }),
      pr(API, { number: 5, head: 'dev', base: 'main' }),
      pr(API, { number: 6, head: 'onprem', base: 'main' }),
      pr(WEB, { number: 7, head: 'onprem', base: 'main' }),
      pr(WEB, { number: 8, head: 'patch-1' }),
      pr(API, { number: 9, head: 'patch-1' }),
      pr(WEB, { number: 10, head: 'feat/login-tests', base: 'feat/login' }),
      pr(WEB, { number: 11, head: 'staging-eu', base: 'prod' }),
      pr(API, { number: 12, head: 'staging-eu', base: 'prod' }),
      pr(API, { number: 13, head: 'fix/lock', base: 'onprem' }),
    ]
    const related = relatePrs(prs, NONE, ['staging-eu'])
    expect(related.get(prs[0]?.url ?? '')?.map((r) => [r.key, r.reasons])).toEqual([
      ['api-2', [{ type: 'same_branch', branch: 'feat/login' }]],
      ['api-3', [{ type: 'same_branch', branch: 'feat/login' }]],
    ])
    expect([...related.keys()]).toHaveLength(3)
  })

  it('merges every reason for one pair', () => {
    const prs = [pr(WEB, { number: 1, head: 'feat/x', refs: [ref(API, 2)] }), pr(API, { number: 2, head: 'feat/x' })]
    expect(relatePrs(prs, NONE).get(prs[1]?.url ?? '')?.[0]?.reasons).toEqual([
      { type: 'mentioned_by', place: 'body' },
      { type: 'same_branch', branch: 'feat/x' },
    ])
  })
})

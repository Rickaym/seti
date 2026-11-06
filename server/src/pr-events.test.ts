import { describe, expect, it } from 'vitest'
import type { WatchedComment, WatchedPr, WatchedReview } from './github.js'
import { freshPosts, prEvents, type PrSnapshot } from './pr-events.js'

function pr(overrides: Partial<WatchedPr> = {}): WatchedPr {
  return {
    url: 'https://github.com/acme/web/pull/7',
    subject: 'acme/web#7',
    state: 'open',
    closed_at: null,
    conflicting: false,
    head_oid: 'aaaaaaa1111',
    ci: 'pending',
    checks: [],
    reviews: [],
    comments: [],
    ...overrides,
  }
}

const review = (overrides: Partial<WatchedReview> = {}): WatchedReview => ({
  id: 'R1',
  state: 'COMMENTED',
  body: 'Looks close.',
  url: 'https://github.com/acme/web/pull/7#pullrequestreview-1',
  submitted_at: '2026-10-07T10:00:00Z',
  author: { login: 'alice', bot: false },
  comments: [],
  ...overrides,
})

const comment = (id: string, body: string, login: string, overrides: Partial<WatchedComment> = {}): WatchedComment => ({
  id,
  body,
  url: `https://github.com/acme/web/pull/7#issuecomment-${id}`,
  created_at: '2026-10-07T10:05:00Z',
  author: { login, bot: false },
  ...overrides,
})

const at = (time: string) => Date.parse(`2026-10-07T${time}Z`)

/** The snapshot after first seeing `base`, then the updates `next` produces. */
function after(base: WatchedPr, next: WatchedPr) {
  const first = prEvents(undefined, base)
  expect(first.inputs).toEqual([])
  return prEvents(first.next, next)
}

describe('prEvents', () => {
  it('only records a baseline the first time it sees a PR', () => {
    const seen = prEvents(undefined, pr({ ci: 'failure', reviews: [review()] }))
    expect(seen.inputs).toEqual([])
    expect(seen.next).toEqual<PrSnapshot>({
      state: 'open',
      conflicting: false,
      ci: { oid: 'aaaaaaa1111', state: 'failure', failing: [] },
      review_ids: ['R1'],
      comment_ids: [],
    })
  })

  it('reports checks that fail later on the same commit, once each', () => {
    const check = (name: string, state: 'failure' | 'pending' | 'success') => ({
      name,
      state,
      detail: state,
      url: null,
    })
    const first = pr({ ci: 'failure', checks: [check('diagram', 'failure'), check('Bot Tests (group 3)', 'pending')] })
    const baseline = prEvents(undefined, pr({ ci: 'pending' })).next
    const reported = prEvents(baseline, first)
    expect(reported.inputs.map((input) => input.title)).toEqual([`CI failed on ${first.subject}`])
    const later = pr({ ci: 'failure', checks: [check('diagram', 'failure'), check('Bot Tests (group 3)', 'failure')] })
    const more = prEvents(reported.next, later)
    expect(more.inputs).toHaveLength(1)
    expect(more.inputs[0]?.title).toBe(`More checks failed on ${later.subject}`)
    expect(more.inputs[0]?.body).toContain('Bot Tests (group 3)')
    expect(more.inputs[0]?.body).not.toContain('diagram')
    expect(prEvents(more.next, later).inputs).toEqual([])
    const legacy = { ...reported.next, ci: { oid: 'aaaaaaa1111', state: 'failure' as const } }
    expect(prEvents(legacy, later).inputs).toEqual([])
  })

  it('reports failing CI once per head commit with the failing checks, and wakes the agent', () => {
    const failing = pr({
      ci: 'failure',
      checks: [
        { name: 'lint', state: 'success', detail: 'success', url: null },
        { name: 'test', state: 'failure', detail: 'failure', url: 'https://ci.example/test' },
      ],
    })
    const { inputs, next } = after(pr(), failing)
    expect(inputs).toEqual([
      {
        source: 'pr',
        kind: 'ci_failed',
        subject: 'acme/web#7',
        title: 'CI failed on acme/web#7',
        body: 'Failing checks on aaaaaaa:\n- test (failure): https://ci.example/test',
        url: 'https://github.com/acme/web/pull/7',
      },
    ])
    expect(prEvents(next, failing).inputs).toEqual([])
  })

  it('reports a pass, and again after a new push or a rerun', () => {
    const passed = after(pr(), pr({ ci: 'success' }))
    expect(passed.inputs).toMatchObject([{ kind: 'ci_passed', body: 'Every check passed on aaaaaaa.' }])
    const pushed = prEvents(passed.next, pr({ head_oid: 'bbbbbbb2222', ci: 'pending' }))
    expect(pushed.inputs).toEqual([])
    expect(pushed.next.ci).toEqual({ oid: 'aaaaaaa1111', state: 'success' })
    expect(prEvents(pushed.next, pr({ head_oid: 'bbbbbbb2222', ci: 'failure' })).inputs).toMatchObject([
      { kind: 'ci_failed' },
    ])
    const failed = after(pr(), pr({ ci: 'failure' }))
    expect(prEvents(failed.next, pr({ ci: 'success' })).inputs).toMatchObject([{ kind: 'ci_passed' }])
  })

  it('forwards a new review with its inline comments, each with its file, line and link', () => {
    const changes = review({
      id: 'R2',
      state: 'CHANGES_REQUESTED',
      body: 'Please rename.',
      comments: [{ path: 'src/a.ts', line: 12, body: 'Use camelCase.', url: 'https://github.com/c/1' }],
    })
    const { inputs } = after(pr({ reviews: [review()] }), pr({ reviews: [review(), changes] }))
    expect(inputs).toEqual([
      {
        source: 'pr',
        kind: 'review',
        subject: 'acme/web#7',
        title: 'alice requested changes on acme/web#7',
        body: 'Please rename.\n\nInline comments:\n- [src/a.ts:12](https://github.com/c/1): Use camelCase.',
        url: changes.url,
      },
    ])
  })

  it('batches the reviews and comments of one poll into one update, oldest first', () => {
    const approved = review({
      id: 'R3',
      state: 'APPROVED',
      body: '',
      submitted_at: '2026-10-07T10:09:00Z',
      author: { login: 'bob', bot: false },
    })
    const first = comment('11', 'Can you also add a test?', 'alice', { created_at: '2026-10-07T10:01:00Z' })
    const second = comment('12', 'And update the docs.', 'octocat', { created_at: '2026-10-07T10:03:00Z' })
    const { inputs } = after(pr(), pr({ reviews: [approved], comments: [first, second] }))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      kind: 'review',
      title: '3 new reviews and comments on acme/web#7',
      url: pr().url,
    })
    expect(inputs[0]?.body).toBe(
      [
        `**alice** commented ([open](${first.url})):\n\nCan you also add a test?`,
        `**octocat** commented ([open](${second.url})):\n\nAnd update the docs.`,
        `**bob** approved ([open](${approved.url}))`,
      ].join('\n\n---\n\n'),
    )
    const comments = after(pr(), pr({ comments: [first, second] })).inputs
    expect(comments).toMatchObject([{ kind: 'comment', title: '2 new comments on acme/web#7' }])
  })

  it('forwards reviews from review bots but drops comments from bots', () => {
    const botReview = review({ id: 'R9', author: { login: 'coderabbitai', bot: true } })
    const botComment = comment('1', 'Preview ready', 'github-actions', {
      author: { login: 'github-actions', bot: true },
    })
    const human = comment('2', 'Can you also add a test?', 'alice', { created_at: '2026-10-07T09:00:00Z' })
    const { inputs } = after(pr(), pr({ reviews: [botReview], comments: [botComment, human] }))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.body).toContain('**alice** commented')
    expect(inputs[0]?.body).toContain('**coderabbitai** reviewed')
    expect(inputs[0]?.body).not.toContain('Preview ready')
  })

  it('forwards what the gh user writes, which is how the user steers the agent', () => {
    const { inputs } = after(pr(), pr({ comments: [comment('3', 'Please rebase', 'OctoCat')] }))
    expect(inputs).toMatchObject([{ kind: 'comment', title: 'OctoCat commented on acme/web#7', body: 'Please rebase' }])
  })

  it('skips the reviews and comments the agents posted, and remembers them', () => {
    const own = comment('4', 'Fixed in abc', 'octocat')
    const ownReview = review({ id: 'R4', author: { login: 'octocat', bot: false } })
    const first = prEvents(undefined, pr())
    const { inputs, next } = prEvents(first.next, pr({ comments: [own], reviews: [ownReview] }), new Set(['4', 'R4']))
    expect(inputs).toEqual([])
    expect(next.comment_ids).toEqual(['4'])
    expect(next.review_ids).toEqual(['R4'])
  })

  it('offers new reviews and comments for the self check, but not bot comments or pending reviews', () => {
    const pending = review({ id: 'R5', state: 'PENDING', submitted_at: null })
    const bot = comment('5', 'scan', 'ci', { author: { login: 'ci', bot: true } })
    const base = prEvents(undefined, pr({ comments: [comment('6', 'old', 'alice')] })).next
    const posts = freshPosts(base, pr({ reviews: [pending, review()], comments: [comment('6', 'old', 'alice'), bot] }))
    expect(posts).toEqual([{ id: 'R1', url: review().url, inline: [], login: 'alice', at: '2026-10-07T10:00:00Z' }])
    expect(freshPosts(undefined, pr({ reviews: [review()] }))).toEqual([])
  })

  it('reports a review left pending when Seti first saw it once it is submitted', () => {
    const pending = review({ id: 'R6', state: 'PENDING', submitted_at: null, author: { login: 'octocat', bot: false } })
    const seen = after(pr(), pr({ reviews: [pending] }))
    expect(seen.inputs).toEqual([])
    expect(seen.next.review_ids).toEqual([])
    const submitted = prEvents(seen.next, pr({ reviews: [{ ...pending, state: 'COMMENTED' }] }))
    expect(submitted.inputs).toMatchObject([{ kind: 'review', title: 'octocat reviewed acme/web#7' }])
  })

  it('sets a new baseline when an ended PR is open again, without replaying what happened since', () => {
    const closed = after(pr(), pr({ state: 'closed' })).next
    const reopened = prEvents(closed, pr({ ci: 'failure', comments: [comment('7', 'Reopening', 'alice')] }))
    expect(reopened.inputs).toEqual([])
    expect(reopened.next).toMatchObject({ state: 'open', comment_ids: ['7'] })
    expect(prEvents(reopened.next, pr({ state: 'merged' })).inputs).toMatchObject([{ kind: 'merged' }])
  })

  it('reports new conflicts once, and the end of the PR', () => {
    const conflicted = after(pr(), pr({ conflicting: true }))
    expect(conflicted.inputs).toMatchObject([{ kind: 'conflict' }])
    expect(prEvents(conflicted.next, pr({ conflicting: true })).inputs).toEqual([])
    expect(after(pr(), pr({ state: 'merged' })).inputs).toMatchObject([
      {
        kind: 'merged',
        title: 'acme/web#7 was merged',
        body: 'Seti unlinked it from this agent; its updates stop here.',
      },
    ])
    expect(after(pr(), pr({ state: 'closed' })).inputs).toMatchObject([
      { kind: 'closed', title: 'acme/web#7 was closed without merging' },
    ])
  })

  describe('the end of a PR', () => {
    const CLOSED_AT = '2026-10-07T10:05:00Z'
    const later = Date.parse('2026-10-07T10:10:00Z')
    const UNLINKED = 'Seti unlinked it from this agent; its updates stop here.'
    const baseline = () => prEvents(undefined, pr()).next

    it('carries the comment it was closed with, and does not deliver it again', () => {
      const why = comment('9', 'Not needed anymore, closing', 'alice', { created_at: CLOSED_AT })
      const ended = pr({ state: 'closed', closed_at: CLOSED_AT, comments: [why] })
      const { inputs, next } = prEvents(baseline(), ended, new Set(), later)
      expect(inputs).toEqual([
        {
          source: 'pr',
          kind: 'closed',
          subject: 'acme/web#7',
          title: 'acme/web#7 was closed without merging',
          body: `alice: Not needed anymore, closing ([open](${why.url}))\n\n${UNLINKED}`,
          url: ended.url,
        },
      ])
      expect(next.comment_ids).toEqual(['9'])
    })

    it('reports a close with no comment as before, and older comments on their own', () => {
      const earlier = comment('10', 'Still needed?', 'alice', { created_at: '2026-10-07T09:00:00Z' })
      const ended = pr({ state: 'closed', closed_at: CLOSED_AT, comments: [earlier] })
      const { inputs } = prEvents(baseline(), ended, new Set(), later)
      expect(inputs).toMatchObject([
        { kind: 'comment', title: 'alice commented on acme/web#7', body: 'Still needed?' },
        { kind: 'closed', body: UNLINKED },
      ])
    })

    it('carries the review a PR merged with', () => {
      const approval = review({ id: 'R9', state: 'APPROVED', body: 'Ship it', submitted_at: '2026-10-07T10:04:30Z' })
      const ended = pr({ state: 'merged', closed_at: CLOSED_AT, reviews: [approval] })
      const { inputs } = prEvents(baseline(), ended, new Set(), later)
      expect(inputs).toMatchObject([
        {
          kind: 'merged',
          title: 'acme/web#7 was merged',
          body: `alice approved: Ship it ([open](${approval.url}))\n\n${UNLINKED}`,
        },
      ])
    })

    it('waits for a comment that lands just after the close, then carries it', () => {
      const start = baseline()
      const closedFirst = prEvents(start, pr({ state: 'closed', closed_at: CLOSED_AT }), new Set(), at('10:05:20'))
      expect(closedFirst).toEqual({ inputs: [], next: start })
      const why = comment('11', 'Superseded by #8', 'alice', { created_at: '2026-10-07T10:05:40Z' })
      const ended = pr({ state: 'closed', closed_at: CLOSED_AT, comments: [why] })
      expect(prEvents(closedFirst.next, ended, new Set(), at('10:06:30')).inputs).toEqual([])
      const { inputs } = prEvents(closedFirst.next, ended, new Set(), at('10:07:10'))
      expect(inputs.map((input) => input.kind)).toEqual(['closed'])
      expect(inputs[0]?.body).toContain('alice: Superseded by #8')
    })

    it('leaves out the closing comment an agent posted', () => {
      const own = comment('12', 'Closing as duplicate', 'octocat', { created_at: CLOSED_AT })
      const ended = pr({ state: 'closed', closed_at: CLOSED_AT, comments: [own] })
      const { inputs } = prEvents(baseline(), ended, new Set(['12']), later)
      expect(inputs).toMatchObject([{ kind: 'closed', body: UNLINKED }])
    })
  })

  it('clips long comment bodies and links the full text', () => {
    const long = comment('8', 'x'.repeat(5000), 'alice')
    const [input] = after(pr(), pr({ comments: [long] })).inputs
    expect(input?.body.length).toBeLessThan(4200)
    expect(input?.body.endsWith(`[... clipped, full text: ${long.url}]`)).toBe(true)
  })
})

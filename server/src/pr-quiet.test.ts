import { describe, expect, it } from 'vitest'
import type { WatchedComment, WatchedPr, WatchedReview } from './github.js'
import { prEvents, type PrReader, type PrSnapshot } from './pr-events.js'
import { endedBy, pushed } from './pr-self.js'

const URL = 'https://github.com/acme/web/pull/7'
const CLOSED_AT = '2026-10-07T10:05:00Z'
const LATER = Date.parse('2026-10-07T10:10:00Z')

function pr(overrides: Partial<WatchedPr> = {}): WatchedPr {
  return {
    url: URL,
    subject: 'acme/web#7',
    state: 'open',
    closed_at: null,
    conflicting: false,
    head_oid: 'aaaaaaa1111',
    clean: false,
    base_ref: 'main',
    ci: 'pending',
    checks: [],
    reviews: [],
    comments: [],
    ...overrides,
  }
}

const comment: WatchedComment = {
  id: 'C1',
  body: '@reviewer please look again',
  url: `${URL}#issuecomment-1`,
  created_at: '2026-10-07T10:00:00Z',
  author: { login: 'octocat', bot: false },
}

const reply: WatchedReview = {
  id: 'R1',
  state: 'COMMENTED',
  body: '',
  url: `${URL}#pullrequestreview-1`,
  submitted_at: '2026-10-07T10:00:00Z',
  author: { login: 'octocat', bot: false },
  comments: [{ path: 'a.ts', line: 4, body: 'Fixed in abc1234', url: `${URL}#discussion_r9` }],
}

const check = (name: string, state: 'failure' | 'success') => ({ name, state, detail: state, url: null })

const baseline = (first: WatchedPr = pr()): PrSnapshot => prEvents(undefined, first).next

/** Each update `next` produces after `first`, as `kind` or `kind:quiet reason`. */
const marks = (previous: PrSnapshot, next: WatchedPr, reader: PrReader = {}): string[] =>
  prEvents(previous, next, reader, LATER).inputs.map((input) =>
    input.quiet === undefined ? input.kind : `${input.kind}:${input.quiet}`,
  )

const AUTHOR: PrReader = { posts: new Set(['C1', 'R1']), ended: true }
const OTHER: PrReader = { posts: new Set(), ended: false }

describe('an action on a PR', () => {
  const actions: [string, WatchedPr, string, string][] = [
    ['comment', pr({ comments: [comment] }), 'comment:own_action', 'comment'],
    ['review reply', pr({ reviews: [reply] }), 'review:own_action', 'review'],
    ['close', pr({ state: 'closed', closed_at: CLOSED_AT }), 'closed:own_action', 'closed'],
    ['merge', pr({ state: 'merged', closed_at: CLOSED_AT }), 'merged:own_action', 'merged'],
  ]

  it.each(actions)('is only recorded for the agent that made it: %s', (_name, next, own) => {
    expect(marks(baseline(), next, AUTHOR)).toEqual([own])
  })

  it.each(actions)('reaches an agent when someone else made it: %s', (_name, next, _own, told) => {
    expect(marks(baseline(), next, OTHER)).toEqual([told])
    expect(marks(baseline(), next)).toEqual([told])
  })

  it('keeps what others wrote apart from what the agent wrote in the same poll', () => {
    const theirs = { ...comment, id: 'C2', author: { login: 'alice', bot: false }, body: 'Rename it' }
    const { inputs } = prEvents(baseline(), pr({ comments: [comment, theirs] }), AUTHOR, LATER)
    expect(inputs).toMatchObject([
      { kind: 'comment', title: 'alice commented on acme/web#7' },
      { kind: 'comment', title: 'octocat commented on acme/web#7', quiet: 'own_action' },
    ])
    expect(inputs[0]?.quiet).toBeUndefined()
  })

  it('tells the agent that merged a PR about the review someone else left with it', () => {
    const approval = {
      ...reply,
      id: 'R2',
      state: 'APPROVED',
      submitted_at: CLOSED_AT,
      author: { login: 'alice', bot: false },
    }
    const { inputs } = prEvents(
      baseline(),
      pr({ state: 'merged', closed_at: CLOSED_AT, reviews: [approval] }),
      AUTHOR,
      LATER,
    )
    expect(inputs).toMatchObject([{ kind: 'merged', quiet: 'own_action' }])
    expect(inputs[0]?.body).toContain('alice approved')
  })
})

describe('a CI pass', () => {
  const green = pr({ ci: 'success' })
  const failed = prEvents(baseline(), pr({ ci: 'failure', checks: [check('test', 'failure')] })).next

  const fixed = pr({ ci: 'success', head_oid: 'bbbbbbb2222' })
  const idle: PrReader = { awaitsCi: false }

  it.each<{ name: string; previous: PrSnapshot; next: WatchedPr; reader: PrReader; mark: string }>([
    { name: 'after a failure on the same commit', previous: failed, next: green, reader: idle, mark: 'ci_passed' },
    {
      name: 'after a failure, on the commit that fixed it',
      previous: failed,
      next: fixed,
      reader: idle,
      mark: 'ci_passed',
    },
    {
      name: 'for an agent that pushed and waits for it',
      previous: baseline(),
      next: green,
      reader: { awaitsCi: true },
      mark: 'ci_passed',
    },
    {
      name: 'when Seti cannot tell whether the agent waits',
      previous: baseline(),
      next: green,
      reader: {},
      mark: 'ci_passed',
    },
    {
      name: 'that nothing waited for',
      previous: baseline(),
      next: green,
      reader: idle,
      mark: 'ci_passed:nothing_pending',
    },
    {
      name: 'after an earlier pass, on a commit the agent did not push',
      previous: prEvents(baseline(), green).next,
      next: fixed,
      reader: idle,
      mark: 'ci_passed:nothing_pending',
    },
  ])('$name', ({ previous, next, reader, mark }) => {
    expect(marks(previous, next, reader)).toEqual([mark])
  })
})

describe('a repeated CI result', () => {
  const red = pr({ ci: 'failure', checks: [check('test', 'failure'), check('lint', 'success')] })
  const told = prEvents(baseline(), red)
  const rerunning = prEvents(told.next, pr({ ci: 'pending' })).next

  it('is reported once while nothing ran again', () => {
    expect(told.inputs).toMatchObject([{ kind: 'ci_failed' }])
    expect(told.inputs[0]?.quiet).toBeUndefined()
    expect(marks(told.next, red)).toEqual([])
  })

  it('is only recorded when a rerun fails the same checks on the same commit', () => {
    expect(rerunning.ci).toMatchObject({ rerun: true })
    const again = prEvents(rerunning, red, {}, LATER)
    expect(again.inputs).toMatchObject([{ kind: 'ci_failed', quiet: 'repeat', title: 'CI failed on acme/web#7' }])
    expect(again.next.ci).toEqual({ oid: 'aaaaaaa1111', state: 'failure', failing: ['test'] })
    expect(marks(again.next, red)).toEqual([])
  })

  it('is news on a new head commit, even with the same failing checks', () => {
    expect(marks(rerunning, pr({ ...red, head_oid: 'bbbbbbb2222' }))).toEqual(['ci_failed'])
  })

  it('is news when a rerun fails a check that passed before', () => {
    const worse = pr({ ci: 'failure', checks: [check('test', 'failure'), check('lint', 'failure')] })
    const { inputs } = prEvents(rerunning, worse, {}, LATER)
    expect(inputs).toMatchObject([{ kind: 'ci_failed', title: 'More checks failed on acme/web#7' }])
    expect(inputs[0]?.quiet).toBeUndefined()
    expect(inputs[0]?.body).toContain('lint')
  })

  it('is news when a rerun turns a failure into a pass, and a pass into a failure', () => {
    expect(marks(rerunning, pr({ ci: 'success' }), { awaitsCi: false })).toEqual(['ci_passed'])
    const passed = prEvents(baseline(), pr({ ci: 'success' })).next
    const again = prEvents(passed, pr({ ci: 'pending' })).next
    expect(marks(again, red)).toEqual(['ci_failed'])
    expect(marks(again, pr({ ci: 'success' }))).toEqual(['ci_passed:repeat'])
  })
})

describe('a merge conflict', () => {
  const conflicted = pr({ conflicting: true })
  const told = prEvents(baseline(), conflicted)
  const unknown = prEvents(told.next, pr()).next

  it('is reported once for a head commit, however often the base moves and GitHub recomputes it', () => {
    expect(told.inputs).toMatchObject([{ kind: 'conflict' }])
    expect(told.next.conflict).toEqual({ base: 'main', head: 'aaaaaaa1111' })
    expect(unknown).toMatchObject({ conflicting: false, conflict: told.next.conflict })
    expect(marks(unknown, conflicted)).toEqual([])
    expect(marks(prEvents(unknown, conflicted).next, conflicted)).toEqual([])
  })

  it.each([
    ['a new head commit that still conflicts', unknown, pr({ conflicting: true, head_oid: 'bbbbbbb2222' })],
    ['another base branch', told.next, pr({ conflicting: true, base_ref: 'release' })],
    [
      'a conflict that came back after the PR merged cleanly',
      prEvents(told.next, pr({ clean: true })).next,
      conflicted,
    ],
  ])('is news on %s', (_name, previous, next) => {
    expect(marks(previous, next)).toEqual(['conflict'])
    expect(marks(prEvents(previous, next).next, next)).toEqual([])
  })

  it('stays reported for a PR whose snapshot predates the record, and without a base to tell it by', () => {
    const legacy: PrSnapshot = { state: 'open', conflicting: true, ci: null, review_ids: [], comment_ids: [] }
    const adopted = prEvents(legacy, conflicted)
    expect(adopted.inputs).toEqual([])
    expect(adopted.next.conflict).toEqual({ base: 'main', head: 'aaaaaaa1111' })
    const gone = pr({ conflicting: true, base_ref: null })
    expect(marks(baseline(), gone)).toEqual(['conflict'])
    expect(marks(prEvents(baseline(), gone).next, gone)).toEqual([])
  })
})

const use = (id: string, name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const bash = (id: string, command: string) => use(id, 'Bash', { command })

describe('endedBy', () => {
  const closedAt = Date.parse(CLOSED_AT)
  const ran = (taskId: string, command: string, from = '10:04:58', to = '10:05:01') => [
    { task_id: taskId, payload: bash(`${taskId}-call`, command), created_at: `2026-10-07T${from}Z` },
    { task_id: taskId, payload: result(`${taskId}-call`, 'done'), created_at: `2026-10-07T${to}Z` },
  ]

  it.each([
    ['gh pr merge 7 --squash --delete-branch'],
    ['gh pr close 7 --comment "Superseded"'],
    ['gh pr merge --squash'],
    ['gh api -X PUT repos/acme/web/pulls/7/merge'],
    ['gh api repos/acme/web/pulls/7 -X PATCH -f state=closed'],
  ])('names the task whose call ended the PR as GitHub timed it: %s', (command) => {
    expect(endedBy(ran('t1', command), URL, closedAt)).toEqual(new Set(['t1']))
  })

  it('names nobody for a call on another PR, a read, or a call that ended long before', () => {
    expect(endedBy(ran('t1', 'gh pr merge 8 --squash'), URL, closedAt)).toEqual(new Set())
    expect(endedBy(ran('t1', 'gh pr merge 7 -R acme/api'), URL, closedAt)).toEqual(new Set())
    expect(endedBy(ran('t1', 'gh pr view 7'), URL, closedAt)).toEqual(new Set())
    expect(endedBy(ran('t1', 'gh pr merge 7 --auto', '09:40:00', '09:40:02'), URL, closedAt)).toEqual(new Set())
  })

  it('reads a GitHub MCP merge, and a close by its state field', () => {
    const rows = [
      {
        task_id: 't1',
        payload: use('m1', 'mcp__github__merge_pull_request', { pullNumber: 7 }),
        created_at: CLOSED_AT,
      },
      {
        task_id: 't2',
        payload: use('m2', 'mcp__github__update_pull_request', { pullNumber: 7, state: 'closed' }),
        created_at: CLOSED_AT,
      },
      {
        task_id: 't3',
        payload: use('m3', 'mcp__github__update_pull_request', { pullNumber: 7, title: 'x' }),
        created_at: CLOSED_AT,
      },
    ]
    expect(endedBy(rows, URL, closedAt)).toEqual(new Set(['t1', 't2']))
  })
})

describe('pushed', () => {
  const row = (payload: string) => ({ task_id: 't1', payload, created_at: CLOSED_AT })

  it.each([
    ['git push'],
    ['git -C /work/web push origin HEAD'],
    ['pnpm check && git commit -m fix && git push -u origin fix/login'],
    ['gh pr create --fill'],
  ])('sees a push or a new PR: %s', (command) => {
    expect(pushed([row(bash('p1', command))])).toBe(true)
  })

  it('sees a GitHub MCP push, and nothing in reads or in what the agent only said', () => {
    expect(pushed([row(use('p1', 'mcp__github__push_files', { branch: 'fix' }))])).toBe(true)
    expect(pushed([row(bash('p2', 'git status && git log --oneline'))])).toBe(false)
    expect(pushed([row(bash('p3', 'echo "git push comes later"'))])).toBe(false)
    expect(pushed([row(result('p4', 'run git push to publish'))])).toBe(false)
  })
})

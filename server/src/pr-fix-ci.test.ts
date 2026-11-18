import { fixCiNudge, fixCiReach, fixCiSkipped, planFixCi, type LinkedTask, type PrRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const task = (id: string, status: LinkedTask['status'] = 'idle'): LinkedTask => ({ id, title: `Agent ${id}`, status })

function row(slug: string, number: number, ci: PrRow['ci'], tasks: LinkedTask[] = []): PrRow {
  return {
    key: `${slug}-${String(number)}`,
    repo_slug: slug,
    number,
    title: `change ${String(number)}`,
    url: `https://github.com/${slug}/pull/${String(number)}`,
    draft: false,
    author: 'octocat',
    head_ref: `feat/${String(number)}`,
    base_ref: 'main',
    updated_at: '2026-10-03T10:00:00Z',
    review_decision: null,
    mergeable: 'mergeable',
    ci,
    tasks,
  }
}

const pr = (repo_slug: string, number: number) => ({ repo_slug, number })

describe('fixCiNudge', () => {
  it('names one PR by number alone', () => {
    expect(fixCiNudge([pr('acme/app', 482)])).toBe('CI is failing on #482. Please fix it.')
  })

  it('names several PRs of one repo in order, each once', () => {
    expect(fixCiNudge([pr('acme/app', 915), pr('acme/app', 482)])).toBe(
      'CI is failing on #482 and #915. Please fix them.',
    )
    expect(fixCiNudge([pr('acme/app', 3), pr('Acme/App', 1), pr('acme/app', 2), pr('acme/app', 3)])).toBe(
      'CI is failing on #1, #2 and #3. Please fix them.',
    )
  })

  it('adds the repo when the PRs span more than one', () => {
    expect(fixCiNudge([pr('acme/docs', 7), pr('acme/app', 482)])).toBe(
      'CI is failing on acme/app#482 and acme/docs#7. Please fix them.',
    )
  })

  it('stays one line with no check names or logs', () => {
    expect(fixCiNudge([pr('acme/app', 1), pr('acme/app', 2)])).not.toMatch(/\n|http|build/)
  })
})

describe('planFixCi', () => {
  const a = task('a')
  const b = task('b', 'running')
  const gone = task('gone')
  const halted = task('halted', 'stopped')
  const rows = [
    row('acme/app', 1, 'failure', [a]),
    row('acme/app', 2, 'failure', [a, b]),
    row('acme/docs', 3, 'failure', [b]),
    row('acme/app', 4, 'success', [a]),
    row('acme/app', 5, 'pending', [b]),
    row('acme/app', 6, 'failure'),
    row('acme/app', 7, 'failure', [gone]),
    row('acme/app', 8, 'failure', [halted]),
    row('acme/app', 9, null, [a]),
  ]
  const plan = planFixCi(rows, new Set(['gone']))

  it('gives each agent one message with its own failing PRs', () => {
    expect(plan.nudges).toEqual([
      { task: a, prs: [pr('acme/app', 1), pr('acme/app', 2)], message: 'CI is failing on #1 and #2. Please fix them.' },
      {
        task: b,
        prs: [pr('acme/app', 2), pr('acme/docs', 3)],
        message: 'CI is failing on acme/app#2 and acme/docs#3. Please fix them.',
      },
    ])
    expect(fixCiReach(plan)).toBe('2 agents about 3 PRs')
  })

  it('skips archived and stopped agents and counts failing PRs with no agent', () => {
    expect(plan.skipped).toEqual([
      { task: gone, reason: 'archived' },
      { task: halted, reason: 'stopped' },
    ])
    expect(plan.unlinked).toBe(1)
    expect(fixCiSkipped(plan)).toBe(
      'Skipped Agent gone (archived) and Agent halted (stopped). Skipped 1 failing PR with no agent.',
    )
  })

  it('covers one agent alone when asked for it', () => {
    const only = planFixCi(rows, new Set(['gone']), 'b')
    expect(only.nudges.map((nudge) => nudge.task.id)).toEqual(['b'])
    expect(only).toMatchObject({ skipped: [], unlinked: 0 })
    expect(fixCiReach(only)).toBe('1 agent about 2 PRs')
    expect(planFixCi(rows, new Set(['gone']), 'gone').skipped).toEqual([{ task: gone, reason: 'archived' }])
  })

  it('plans nothing when no PR fails', () => {
    const quiet = planFixCi([row('acme/app', 4, 'success', [a])], new Set())
    expect(quiet).toEqual({ nudges: [], skipped: [], unlinked: 0 })
    expect(fixCiSkipped(quiet)).toBe('')
  })
})

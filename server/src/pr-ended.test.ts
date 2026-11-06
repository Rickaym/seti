import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { unlinkEndedPrs } from './pr-ended.js'
import type { PrSnapshot } from './pr-events.js'
import { auditEvents } from './store/audit.js'
import { prDismissals } from './store/pr-discovery.js'
import { prWatch } from './store/pr-watch.js'
import { subtaskPrs } from './store/subtasks.js'
import { linkDiscoveredPr } from './tasks.js'

const MERGED = 'https://github.com/acme/web/pull/1'
const CLOSED = 'https://github.com/acme/web/pull/2'
const OPEN = 'https://github.com/acme/web/pull/3'
const NEW = 'https://github.com/acme/web/pull/4'

const snapshot = (state: PrSnapshot['state']): PrSnapshot => ({
  state,
  conflicting: false,
  ci: null,
  review_ids: [],
  comment_ids: [],
})

async function watch(url: string, state: PrSnapshot['state'], checkedAt: string): Promise<void> {
  await prWatch.save(url, snapshot(state))
  await sql`UPDATE pr_watch SET checked_at = ${checkedAt} WHERE pr_url = ${url}`
}

const linkedAt = async (taskId: string, url: string, at: string) =>
  sql`UPDATE task_pr SET linked_at = ${at} WHERE task_id = ${taskId} AND pr_url = ${url}`

beforeAll(async () => {
  await sql`INSERT INTO task (id, title, cwd, status, input_mode, created_at, updated_at) VALUES
    ('landed', 'Landed', '/tmp', 'idle', 'wake', '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z'),
    ('sharing', 'Sharing', '/tmp', 'idle', 'wake', '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z')`
  for (const url of [MERGED, CLOSED, OPEN]) {
    await tasks.linkPr('landed', url, 'agent')
    await linkedAt('landed', url, '2026-10-01T09:00:00.000Z')
  }
  await tasks.linkPr('sharing', MERGED, 'user')
  await linkedAt('sharing', MERGED, '2026-10-01T09:00:00.000Z')
  await subtaskPrs.link('sharing', MERGED, 'toolu_sub', 'agent')
  await watch(MERGED, 'merged', '2026-10-02T09:00:00.000Z')
  await watch(CLOSED, 'closed', '2026-10-02T09:00:00.000Z')
  await watch(OPEN, 'open', '2026-10-02T09:00:00.000Z')
})

describe('unlinking PRs that merged or closed', () => {
  it('stops watching them, and lists the links to drop with their state and subagent', async () => {
    expect(await prWatch.watched()).toEqual([OPEN])
    const ended = await prWatch.endedLinks()
    expect(ended.map((link) => [link.task_id, link.pr_url, link.state, link.tool_use_id])).toEqual([
      ['landed', MERGED, 'merged', null],
      ['landed', CLOSED, 'closed', null],
      ['sharing', MERGED, 'merged', 'toolu_sub'],
    ])
  })

  it('unlinks them from every task and subagent, audits why, and keeps them unlinked', async () => {
    expect((await unlinkEndedPrs()).toSorted((a, b) => a.localeCompare(b))).toEqual(['landed', 'sharing'])
    expect((await tasks.get('landed'))?.pr_urls).toEqual([OPEN])
    expect((await tasks.get('sharing'))?.pr_urls).toEqual([])
    expect(await subtaskPrs.ofTask('sharing')).toEqual(new Map())
    expect(await prDismissals.list('landed')).toEqual(new Set([MERGED, CLOSED]))
    expect(await unlinkEndedPrs()).toEqual([])

    await auditEvents.settled()
    const page = await auditEvents.page({ kind: 'task.pr_unlinked', limit: 10 })
    expect(page.events.map((event) => [event.subject_id, event.actor, event.summary, event.detail.reason])).toEqual([
      ['sharing', 'system', 'Unlinked PR acme/web#1 (it merged)', 'it merged'],
      ['landed', 'system', 'Unlinked PR acme/web#2 (it closed)', 'it closed'],
      ['landed', 'system', 'Unlinked PR acme/web#1 (it merged)', 'it merged'],
    ])
    expect(await linkDiscoveredPr('landed', MERGED, 'opened by the task')).toBe(false)
  })

  it('keeps the states of the PRs it unlinked, so an agent whose PR merged still shows complete', async () => {
    expect(await prWatch.taskStates('landed')).toEqual({ [MERGED]: 'merged', [CLOSED]: 'closed', [OPEN]: 'open' })
    expect((await prWatch.allTaskStates()).get('sharing')).toEqual({ [MERGED]: 'merged' })
  })

  it('polls a PR linked again after it ended, and keeps it while it is open again', async () => {
    await tasks.linkPr('sharing', CLOSED, 'user')
    expect(await prWatch.watched()).toEqual([CLOSED, OPEN])
    expect(await prWatch.endedLinks()).toEqual([])
    await watch(CLOSED, 'open', new Date().toISOString())
    expect(await unlinkEndedPrs()).toEqual([])
    expect((await tasks.get('sharing'))?.pr_urls).toEqual([CLOSED])
  })

  it('drops a PR that was already merged when it was first seen', async () => {
    await tasks.linkPr('landed', NEW, 'user')
    await linkedAt('landed', NEW, '2026-10-03T09:00:00.000Z')
    await watch(NEW, 'merged', '2026-10-03T09:01:00.000Z')
    expect(await unlinkEndedPrs()).toEqual(['landed'])
    expect((await tasks.get('landed'))?.pr_urls).toEqual([OPEN])
  })
})

import type { ChangeRequest, KnowledgeNote, PendingRequests, PermissionRequest, Question } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { kindCounts, kindsWaiting, requestGroups } from '@/panels/requests/groups'

const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`

const question = (id: string, taskId: string, minute: number) =>
  ({ id, task_id: taskId, task_title: `Agent ${taskId}`, created_at: at(minute) }) as Question

const access = (id: string, taskId: string, minute: number) =>
  ({ id, task_id: taskId, task_title: `Agent ${taskId}`, created_at: at(minute) }) as ChangeRequest & {
    task_title: string
  }

const permission = (id: string, taskId: string, minute: number, tool = 'Bash') =>
  ({
    id,
    task_id: taskId,
    task_title: `Agent ${taskId}`,
    tool_name: tool,
    created_at: at(minute),
    digest: `digest-${id}`,
  }) as PermissionRequest & {
    task_title: string
    digest: string
  }

const note = (id: string, minute: number, extra: Partial<KnowledgeNote> = {}) =>
  ({
    id,
    proposer: 'agent',
    proposer_task_id: null,
    proposer_title: null,
    created_at: at(minute),
    ...extra,
  }) as KnowledgeNote

const pending: PendingRequests = {
  questions: [question('q1', 'b', 5), question('q2', 'b', 6)],
  access: [access('a1', 'c', 3)],
  permissions: [permission('p1', 'a', 8, 'ExitPlanMode'), permission('p2', 'c', 9)],
  notes: [note('n1', 1, { proposer_task_id: 'd', proposer_title: 'Agent d' }), note('n2', 2, { proposer: 'ea' })],
}

describe('the Requests panel groups', () => {
  it('counts each kind and lists only the kinds that wait', () => {
    const counts = kindCounts(pending)
    expect(counts).toEqual({ questions: 2, access: 1, plans: 1, tools: 1, notes: 2 })
    expect(kindsWaiting({ ...counts, plans: 0 })).toEqual(['questions', 'access', 'tools', 'notes'])
  })

  it('puts the agents a request holds up first, the longest wait first, and notes last', () => {
    const groups = requestGroups(pending, 'all')
    expect(groups.map((group) => group.key)).toEqual(['c', 'b', 'a', 'd', 'ea'])
    expect(groups[0]).toMatchObject({ title: 'Agent c', holds: true, since: at(3) })
    expect(groups[0]?.access.map((request) => request.id)).toEqual(['a1'])
    expect(groups[0]?.tools.map((request) => request.id)).toEqual(['p2'])
    expect(groups[2]?.plans.map((request) => request.id)).toEqual(['p1'])
    expect(groups.at(-1)).toMatchObject({ taskId: null, title: 'The EA', holds: false })
  })

  it('shows one kind when the filter picks it', () => {
    expect(requestGroups(pending, 'plans').map((group) => group.key)).toEqual(['a'])
    expect(requestGroups(pending, 'notes').map((group) => group.key)).toEqual(['d', 'ea'])
    expect(requestGroups(pending, 'tools').map((group) => group.tools.length)).toEqual([1])
  })
})

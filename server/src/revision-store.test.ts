import { beforeAll, describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { revisions } from './store/revisions.js'

beforeAll(async () => {
  await tasks.insert({ id: 'legacy-task', title: 'Legacy', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
})

describe('revision store', () => {
  it('stores a revision with the title of the task that made it', async () => {
    const stored = await revisions.insert({
      actor: 'agent',
      task_id: 'legacy-task',
      object_type: 'context_pack',
      object_id: 'p1',
      before: { body: 'a' },
      after: { body: 'b' },
      reason: 'feedback',
    })
    expect(stored).toMatchObject({ kind: 'updated', task_title: 'Legacy' })
  })

  it('clears the task link when the task is deleted', async () => {
    await tasks.remove('legacy-task')
    expect(await revisions.list({ object_type: 'context_pack', object_id: 'p1' }, 10)).toEqual([
      expect.objectContaining({ task_id: null, task_title: null, reason: 'feedback' }),
    ])
  })
})

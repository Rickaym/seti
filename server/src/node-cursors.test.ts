import { describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { nodeCursors } from './store/node-cursors.js'

describe('node cursors', () => {
  it('keeps one cursor per agent and forgets it with the agent', async () => {
    const agent = 'node-cursor-task'
    await tasks.insert({ id: agent, title: agent, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await nodeCursors.save({ agent, epoch: 'e1', seq: 3 })
    await nodeCursors.save({ agent, epoch: 'e2', seq: 1 })
    expect((await nodeCursors.list()).filter((cursor) => cursor.agent === agent)).toEqual([
      { agent, epoch: 'e2', seq: 1 },
    ])
    await tasks.remove(agent)
    expect((await nodeCursors.list()).some((cursor) => cursor.agent === agent)).toBe(false)
  })
})

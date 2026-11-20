import type { Task } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { archiveTask } from './archive.js'
import { tasks } from './db.js'
import { onSelf, refuseOnSelf } from './ea-guard.js'
import { rewindTask } from './rewind-task.js'
import { restartSession } from './session-restart.js'
import { deleteTask, endTaskSession, retryTask, switchBackModel } from './task-actions.js'
import { stopTask } from './task-transcript.js'

createApp()
let count = 0

async function newTask(): Promise<Task> {
  count += 1
  const id = `self-task-${String(count)}`
  await tasks.insert({ id, title: `Self ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return { ...task, seti_control: 'full' }
}

const ACTIONS: readonly { what: string; run: (task: Task) => Promise<unknown> }[] = [
  { what: 'stop', run: async (task) => stopTask(task.id) },
  { what: 'archive', run: async (task) => archiveTask(task.id, { actor: 'user', removeWorktree: true }) },
  { what: 'delete', run: async (task) => deleteTask(task) },
  { what: 'rewind', run: async (task) => rewindTask(task.id, 1, 'conversation') },
  { what: 'restart', run: async (task) => restartSession(task, { interrupt: true }) },
  { what: 'end the background work of', run: async (task) => endTaskSession(task.id) },
  { what: 'retry the turn of', run: async (task) => retryTask(task.id) },
  { what: 'switch back the model of', run: async (task) => switchBackModel(task.id) },
]

describe('an agent at Seti control Full', () => {
  it.each(ACTIONS)('cannot $what itself, whoever calls the core function for it', async ({ what, run }) => {
    const self = await newTask()
    await expect(asAgent(self, async () => run(self))).rejects.toMatchObject({ status: 403, message: onSelf(what) })
    expect((await tasks.get(self.id))?.archived_at).toBeNull()
  })

  it('is refused only for itself, and the user never is', async () => {
    const [self, other] = [await newTask(), await newTask()]
    await asAgent(self, async () => {
      expect(() => {
        refuseOnSelf(other.id, 'stop')
      }).not.toThrow()
      return Promise.resolve()
    })
    expect(() => {
      refuseOnSelf(self.id, 'stop')
    }).not.toThrow()
  })
})

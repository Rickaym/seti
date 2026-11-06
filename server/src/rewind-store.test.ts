import { beforeAll, describe, expect, it } from 'vitest'
import { messages, tasks } from './db.js'
import { rewinds, type NewRewind } from './store/rewinds.js'

let promptId = 0

beforeAll(async () => {
  await tasks.insert({ id: 'legacy-task', title: 'Legacy', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  promptId = (await messages.insert('legacy-task', { kind: 'prompt', payload: { text: 'hello' } }, [])).id
})

const rewind = (fields: Partial<NewRewind> = {}): NewRewind => ({
  task_id: 'legacy-task',
  prompt_message_id: promptId,
  last_message_id: promptId,
  message_count: 1,
  prompt_text: 'hello',
  restore: 'conversation',
  state: 'pending',
  resume_at: null,
  drops_turn: null,
  files_changed: [],
  ...fields,
})

describe('rewind store', () => {
  it('starts a task with no rewinds', async () => {
    expect((await messages.page('legacy-task', 10)).messages).toEqual([
      expect.objectContaining({ kind: 'prompt', payload: { text: 'hello' } }),
    ])
    expect(await rewinds.list('legacy-task')).toEqual([])
  })

  it('keeps one pending rewind per task and settles it once', async () => {
    const first = await rewinds.insert(rewind({ resume_at: 'a1' }))
    const second = await rewinds.insert(rewind({ resume_at: 'a2', drops_turn: 'u2' }))
    expect(await rewinds.pending('legacy-task')).toEqual({ id: second.id, resume_at: 'a2', drops_turn: 'u2' })
    expect((await rewinds.list('legacy-task')).map((r) => r.state)).toEqual(['superseded', 'pending'])
    await rewinds.settle(first.id, 'applied')
    await rewinds.settle(second.id, 'applied')
    expect(await rewinds.pending('legacy-task')).toBeUndefined()
    expect((await rewinds.list('legacy-task')).map((r) => r.state)).toEqual(['superseded', 'applied'])
    const code = await rewinds.insert(rewind({ restore: 'code', state: 'applied', files_changed: ['/a'] }))
    expect(code).toMatchObject({ files_changed: ['/a'], state: 'applied' })
    expect((await rewinds.list('legacy-task')).at(1)?.state).toBe('applied')
  })

  it('drops rewinds with their task', async () => {
    expect(await rewinds.list('legacy-task')).toHaveLength(3)
    await tasks.remove('legacy-task')
    expect(await rewinds.list('legacy-task')).toEqual([])
  })
})

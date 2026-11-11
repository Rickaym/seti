import { describe, expect, it } from 'vitest'
import { messages, tasks } from './db.js'
import { asides, type NewAside } from './store/asides.js'

let count = 0

async function newTask(): Promise<string> {
  const id = `aside-store-${String(++count)}`
  await tasks.insert({ id, title: `Aside ${String(count)}`, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  return id
}

const row = (taskId: string, n: number, extra: Partial<NewAside> = {}): NewAside => ({
  id: `00000000-0000-4000-8000-${String(count * 100 + n).padStart(12, '0')}`,
  task_id: taskId,
  chat_id: 'chat-a',
  question: `question ${String(n)}`,
  answer: `answer ${String(n)}`,
  asked_by: 'user',
  asker_id: null,
  asker_title: null,
  cost_usd: 0.01,
  asked_at: `2026-11-11T10:00:${String(n).padStart(2, '0')}.000Z`,
  answered_at: `2026-11-11T10:01:${String(n).padStart(2, '0')}.000Z`,
  ...extra,
})

describe('the aside store', () => {
  it('keeps asides per agent, oldest first, apart from its transcript rows', async () => {
    const id = await newTask()
    const other = await newTask()
    await asides.add(row(id, 2))
    const first = await asides.add(row(id, 1, { asked_by: 'agent', asker_id: other, asker_title: 'Aside 2' }))
    await asides.add(row(other, 3))
    expect(first).toMatchObject({ asked_by: 'agent', asker_id: other, cost_usd: 0.01 })
    expect((await asides.list(id)).map((a) => a.question)).toEqual(['question 1', 'question 2'])
    expect((await asides.list(id, 1)).map((a) => a.question)).toEqual(['question 2'])
    expect((await messages.page(id, 50)).messages).toEqual([])
  })

  it('reads the newest exchanges of one chat, oldest first', async () => {
    const id = await newTask()
    for (const n of [1, 2, 3]) {
      await asides.add(row(id, n))
    }
    await asides.add(row(id, 4, { chat_id: 'chat-b' }))
    expect((await asides.chat(id, 'chat-a', 2)).map((a) => a.question)).toEqual(['question 2', 'question 3'])
    expect(await asides.chat(id, 'chat-c', 2)).toEqual([])
  })

  it('deletes one aside of the agent, or all of them', async () => {
    const id = await newTask()
    const other = await newTask()
    const kept = await asides.add(row(id, 1))
    await asides.add(row(id, 2))
    const foreign = await asides.add(row(other, 3))
    expect(await asides.remove(id, foreign.id)).toBeNull()
    expect(await asides.remove(id, kept.id)).toMatchObject({ id: kept.id })
    expect(await asides.remove(id, kept.id)).toBeNull()
    expect(await asides.clear(id)).toBe(1)
    expect(await asides.list(id)).toEqual([])
    expect(await asides.list(other)).toHaveLength(1)
  })

  it('goes with the agent when it is deleted', async () => {
    const id = await newTask()
    await asides.add(row(id, 1))
    await tasks.remove(id)
    expect(await asides.list(id)).toEqual([])
  })
})

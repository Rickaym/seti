import type { EaHistoryEntry, EaHistoryPage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { EaHistoryStore, SETTLE_MS } from './history-store'

const AT = '2026-09-27T12:00:00.000Z'

const say = (id: number, content: string): EaHistoryEntry => ({
  id,
  kind: 'message',
  message: { role: 'user', content },
  through_id: null,
  created_at: AT,
})

const BEFORE: EaHistoryEntry[] = [say(1, 'Earlier question?')]
const AFTER: EaHistoryEntry[] = [...BEFORE, say(2, 'Live question?')]

function historyStore(pages: EaHistoryPage[]) {
  const tasks: (() => void)[] = []
  let cleared = 0
  let loads = 0
  const store = new EaHistoryStore({
    load: async () => {
      const page = pages[Math.min(loads, pages.length - 1)] ?? { entries: [], has_older: false }
      loads += 1
      return Promise.resolve(page)
    },
    clear: async () => {
      cleared += 1
      return Promise.resolve()
    },
    later: (task, ms) => {
      expect(ms).toBe(SETTLE_MS)
      tasks.push(task)
    },
  })
  return { store, tasks, cleared: () => cleared }
}

const settle = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

describe('EaHistoryStore', () => {
  it('loads again once the bot has had time to store the end of a call', async () => {
    const { store, tasks } = historyStore([
      { entries: BEFORE, has_older: false },
      { entries: AFTER, has_older: true },
    ])
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ entries: BEFORE, loading: false })

    store.callEnded()
    expect(store.getSnapshot().entries).toEqual(BEFORE)
    tasks.shift()?.()
    await settle()
    expect(store.getSnapshot()).toMatchObject({ entries: AFTER, hasOlder: true })
  })

  it('keeps the reason when a load fails', async () => {
    const store = new EaHistoryStore({
      load: async () => Promise.reject(new Error('Seti is down')),
      clear: async () => Promise.resolve(),
      later: () => undefined,
    })
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ entries: [], loading: false, error: 'Seti is down' })
  })

  it('forgets the conversation and drops a page that was loading before it', async () => {
    const { store, cleared } = historyStore([{ entries: AFTER, has_older: false }])
    const loading = store.refresh()
    await store.clear()
    await loading
    expect(cleared()).toBe(1)
    expect(store.getSnapshot()).toMatchObject({ entries: [], epoch: 1 })
  })
})

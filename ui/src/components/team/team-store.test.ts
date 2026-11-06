import type { TeamMessage } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shownMessages, TeamChatStore, unreadCount } from './team-store'

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

const message = (id: number, author: TeamMessage['author_kind'] = 'task'): TeamMessage => ({
  id,
  author_kind: author,
  author_task_id: author === 'task' ? 'task-1' : null,
  author_handle: author === 'task' ? 'voicemail' : null,
  text: `message ${String(id)}`,
  mentions: [],
  to_kind: null,
  to_task_id: null,
  to_handle: null,
  created_at: '2026-09-28T10:00:00.000Z',
})

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('group chat store', () => {
  it('counts what was there on a first visit as seen, then messages from others', () => {
    const store = new TeamChatStore()
    store.receive([message(1), message(2)])
    expect(unreadCount(store.getSnapshot())).toBe(0)
    store.receive([message(3), message(4, 'user'), message(5, 'ea')])
    expect(unreadCount(store.getSnapshot())).toBe(2)
    expect(storage.getItem('seti.team.seen')).toBe('2')
  })

  it('marks everything seen while open and remembers the panel across reloads', () => {
    const store = new TeamChatStore()
    store.receive([message(1)])
    store.receive([message(2)])
    store.setOpen(true)
    expect(unreadCount(store.getSnapshot())).toBe(0)
    store.receive([message(3)])
    expect(unreadCount(store.getSnapshot())).toBe(0)
    const reloaded = new TeamChatStore()
    expect(reloaded.getSnapshot()).toMatchObject({ open: true, seen: 3 })
  })

  it('starts closed where the caller asks not to restore the panel, as phones do', () => {
    new TeamChatStore().setOpen(true)
    expect(new TeamChatStore({ restoreOpen: false }).getSnapshot().open).toBe(false)
  })

  it('merges repeated messages once, in id order', () => {
    const store = new TeamChatStore()
    store.receive([message(2), message(1)])
    store.receive([message(2), message(3)])
    expect(store.getSnapshot().messages.map((m) => m.id)).toEqual([1, 2, 3])
  })
})

describe('group chat window around a search hit', () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i))
  const ids = (rows: readonly TeamMessage[]) => rows.map((m) => m.id)

  /** Answers the store's requests from 500 messages on the server. */
  function serve(): string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      const query = new URL(url, 'https://seti.test').searchParams
      const limit = Number(query.get('limit'))
      const around = query.get('around')
      const after = query.get('after')
      let data: unknown
      if (around !== null) {
        const id = Number(around)
        data = { messages: range(id - limit / 2, id + limit / 2 - 1), has_older: true, has_newer: id + limit / 2 < 500 }
      } else if (after !== null) {
        data = range(Number(after) + 1, Math.min(500, Number(after) + limit))
      } else {
        data = []
      }
      return Promise.resolve(new Response(JSON.stringify({ data })))
    })
    return asked
  }

  it('shows a window far back, keeps live messages apart, and returns to the latest', async () => {
    const asked = serve()
    const store = new TeamChatStore()
    store.receive(range(451, 500))
    await store.jumpTo(100)
    const state = store.getSnapshot()
    expect(asked).toEqual(['/api/team/messages?around=100&limit=50'])
    expect(ids(shownMessages(state).messages)).toEqual(ids(range(75, 124)))
    store.receive([message(501)])
    expect(ids(shownMessages(store.getSnapshot()).messages)).toEqual(ids(range(75, 124)))
    store.backToLatest()
    expect(shownMessages(store.getSnapshot()).messages.at(-1)?.id).toBe(501)
    expect(store.getSnapshot().latestRequest).toBe(1)
  })

  it('skips the fetch for a loaded hit and rejoins once later pages reach the newest', async () => {
    const asked = serve()
    const store = new TeamChatStore()
    store.receive(range(451, 500))
    await store.jumpTo(460)
    expect(asked).toEqual([])
    await store.jumpTo(400)
    expect(store.getSnapshot().window?.has_newer).toBe(true)
    await store.loadNewer()
    expect(ids(shownMessages(store.getSnapshot()).messages)).toEqual(ids(range(375, 474)))
    await store.loadNewer()
    expect(store.getSnapshot().window).toBeNull()
    expect(ids(store.getSnapshot().messages)).toEqual(ids(range(375, 500)))
  })
})

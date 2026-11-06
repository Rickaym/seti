import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { cacheTranscript, cachedTranscript, withBacklog } from '@/lib/transcript-cache'

const row = (id: number, text = `row ${String(id)}`): MessageRow => ({
  id,
  task_id: 't',
  outward: [],
  created_at: '2026-09-01T11:00:00.000Z',
  kind: 'prompt',
  payload: { text },
})

const rows = (...ids: number[]) => ids.map((id) => row(id))

describe('withBacklog', () => {
  it('takes the page as is when nothing was shown', () => {
    const page = { messages: rows(5, 6), has_older: true }
    expect(withBacklog({ messages: [], hasOlder: false }, page)).toEqual({ messages: page.messages, hasOlder: true })
  })

  it('keeps earlier shown rows the page reaches back to and takes fresh copies of the rest', () => {
    const fresh = row(4, 'edited')
    const result = withBacklog(
      { messages: rows(1, 2, 3, 4), hasOlder: false },
      { messages: [row(3), fresh, row(5)], has_older: true },
    )
    expect(result.messages.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    expect(result.messages[3]).toBe(fresh)
    expect(result.hasOlder).toBe(false)
  })

  it('drops shown rows when the page starts after them, so no gap opens', () => {
    const result = withBacklog({ messages: rows(1, 2), hasOlder: false }, { messages: rows(9, 10), has_older: true })
    expect(result).toEqual({ messages: rows(9, 10), hasOlder: true })
  })

  it('empties a transcript whose rows are gone', () => {
    expect(withBacklog({ messages: rows(1, 2), hasOlder: true }, { messages: [], has_older: false })).toEqual({
      messages: [],
      hasOlder: false,
    })
  })
})

describe('cacheTranscript', () => {
  it('keeps the twelve most recently cached agents', () => {
    for (let n = 0; n < 14; n++) {
      cacheTranscript(`task-${String(n)}`, { messages: rows(n), hasOlder: false }, null)
    }
    cacheTranscript('task-2', { messages: rows(2, 3), hasOlder: true }, '3.ab.7')
    cacheTranscript('task-14', { messages: rows(14), hasOlder: false }, null)
    expect(cachedTranscript('task-0')).toBeUndefined()
    expect(cachedTranscript('task-1')).toBeUndefined()
    expect(cachedTranscript('task-3')).toBeUndefined()
    expect(cachedTranscript('task-2')).toEqual({ rows: { messages: rows(2, 3), hasOlder: true }, cursor: '3.ab.7' })
    expect(cachedTranscript('task-14')?.rows.messages).toHaveLength(1)
  })
})

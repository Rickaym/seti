import { describe, expect, it } from 'vitest'
import { shareEqual } from '@/lib/share-equal'

const tasks = () => [
  { id: 'a', title: 'Alpha', pr_urls: ['https://github.com/o/r/pull/1'], meta: { color: null } },
  { id: 'b', title: 'Beta', pr_urls: [], meta: { color: 'blue' } },
]

describe('shareEqual', () => {
  it('hands back the earlier value when the new one deep-equals it', () => {
    const prev = tasks()
    expect(shareEqual(prev, tasks())).toBe(prev)
  })

  it('keeps unchanged items and builds new ones only along the changed path', () => {
    const prev = tasks()
    const next = tasks()
    next[1] = { ...next[1], title: 'Beta two' } as (typeof next)[number]
    const shared = shareEqual(prev, next)
    expect(shared).not.toBe(prev)
    expect(shared[0]).toBe(prev[0])
    expect(shared[1]).not.toBe(prev[1])
    expect(shared[1]?.meta).toBe(prev[1]?.meta)
    expect(shared[1]?.title).toBe('Beta two')
  })

  it('pairs items by id, so an item added in front keeps the rest as they were', () => {
    const prev = tasks()
    const next = [{ id: 'c', title: 'Gamma', pr_urls: [], meta: { color: null } }, ...tasks()]
    const shared = shareEqual(prev, next)
    expect(shared[1]).toBe(prev[0])
    expect(shared[2]).toBe(prev[1])
    expect(shared[0]).toBe(next[0])
  })

  it('sees removed items and keys as changes', () => {
    const prev = tasks()
    expect(shareEqual(prev, tasks().slice(0, 1))).toEqual(tasks().slice(0, 1))
    const record = { a: 1, b: 2 }
    const fewer = shareEqual(record, { a: 1 })
    expect(fewer).toEqual({ a: 1 })
    expect(fewer).not.toBe(record)
    const swapped = shareEqual(record, { a: 1, c: 2 })
    expect(swapped).toEqual({ a: 1, c: 2 })
  })

  it('returns new primitives, nulls and class instances as given', () => {
    expect(shareEqual(1, 2)).toBe(2)
    expect(shareEqual({ a: 1 }, null)).toBeNull()
    const date = new Date(0)
    expect(shareEqual(new Date(0), date)).toBe(date)
    const items = [1, 2]
    expect(shareEqual({ 0: 1, 1: 2 }, items)).toBe(items)
  })
})

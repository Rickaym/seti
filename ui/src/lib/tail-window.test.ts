import { describe, expect, it } from 'vitest'
import { grownFrom, WHOLE, windowStart } from '@/lib/tail-window'

const ids = Array.from({ length: 150 }, (_, index) => 1000 + index * 2)

describe('windowStart', () => {
  it('shows the newest rows until the window is pinned to a row', () => {
    expect(windowStart(ids, null, 60)).toBe(90)
    expect(windowStart(ids.slice(0, 20), null, 60)).toBe(0)
  })

  it('keeps its top row as new rows arrive below', () => {
    const from = ids[90] ?? 0
    expect(windowStart([...ids, 1300, 1302], from, 60)).toBe(90)
  })

  it('starts at the next row when its top row is gone', () => {
    expect(windowStart(ids, (ids[90] ?? 0) + 1, 60)).toBe(91)
    expect(windowStart(ids, 99_999, 60)).toBe(ids.length)
  })
})

describe('grownFrom', () => {
  it('grows the window back by a step of loaded rows', () => {
    expect(grownFrom(ids, 90, 60)).toBe(ids[30])
  })

  it('shows every loaded row once a step reaches the first', () => {
    expect(grownFrom(ids, 30, 60)).toBe(WHOLE)
    expect(grownFrom(ids, 60, 60)).toBe(WHOLE)
    expect(windowStart(ids, WHOLE, 60)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { olderOwn, ownMove, ownNav, READ_LINE, sameNav, type OwnView } from '@/lib/own-messages'

/** Own messages 40px tall at `tops` in a 600px view, at the newest messages and fully loaded. */
const view = (tops: number[], extra: Partial<OwnView> = {}): OwnView => ({
  tops,
  bottoms: tops.map((top) => top + 40),
  height: 600,
  cursor: null,
  hasOlder: false,
  indexed: false,
  atLatest: true,
  ...extra,
})

describe('ownNav', () => {
  it('hides while every own message is in view and none was stepped to', () => {
    expect(ownNav(view([100, 300])).show).toBe(false)
    expect(ownNav(view([])).show).toBe(false)
  })

  it('shows once an own message sits above or below the view', () => {
    expect(ownNav(view([-500, 300])).show).toBe(true)
    expect(ownNav(view([100, 700])).show).toBe(true)
  })

  it('steps back first to the newest own message above the reading line', () => {
    const nav = ownNav(view([-2000, -900, 300]))
    expect(nav.back).toBe(1)
    expect(nav.forward).toBe(2)
  })

  it('steps on from the message it landed on while the view has not moved', () => {
    const landed = view([-900, READ_LINE, 900], { cursor: { index: 1, top: READ_LINE }, atLatest: false })
    const nav = ownNav(landed)
    expect(nav.back).toBe(0)
    expect(nav.forward).toBe(2)
    expect(nav.show).toBe(true)
    expect(nav.position).toEqual({ at: 2, of: 3 })
  })

  it('steps from a message that could not reach the top, as at the bottom of the transcript', () => {
    const nav = ownNav(view([-900, 420], { cursor: { index: 1, top: 420 } }))
    expect(nav.back).toBe(0)
  })

  it('forgets the landed message once the view scrolled away from it', () => {
    const moved = view([-900, -300, 900], { cursor: { index: 1, top: READ_LINE }, atLatest: false })
    const nav = ownNav(moved)
    expect(nav.back).toBe(1)
    expect(nav.forward).toBe(2)
    expect(nav.position).toBeNull()
  })

  it('loads an earlier page when no earlier own message is loaded, and stops at the oldest otherwise', () => {
    const first = { cursor: { index: 0, top: READ_LINE } }
    expect(ownNav(view([READ_LINE, 900], { ...first, hasOlder: true })).back).toBe('older')
    expect(ownNav(view([READ_LINE, 900], first)).back).toBeNull()
    expect(ownNav(view([200], { hasOlder: true })).back).toBe('older')
  })

  it('returns to the newest messages past the last own one, unless it shows them already', () => {
    const last = { cursor: { index: 1, top: READ_LINE } }
    expect(ownNav(view([-900, READ_LINE], { ...last, atLatest: false })).forward).toBe('latest')
    expect(ownNav(view([-900, READ_LINE], last)).forward).toBeNull()
  })

  it('leaves out the position while earlier pages may hold more own messages', () => {
    const landed = view([-900, READ_LINE], { cursor: { index: 1, top: READ_LINE }, hasOlder: true })
    expect(ownNav(landed).position).toBeNull()
  })
})

describe('sameNav', () => {
  it('compares by value, position included', () => {
    const a = ownNav(view([-900, READ_LINE], { cursor: { index: 1, top: READ_LINE } }))
    const b = ownNav(view([-900, READ_LINE], { cursor: { index: 1, top: READ_LINE } }))
    expect(sameNav(a, b)).toBe(true)
    expect(sameNav(a, ownNav(view([-900, READ_LINE])))).toBe(false)
  })

  it('stays the same while scrolling moves the targets from one own message to the next', () => {
    const above = ownNav(view([-900, -400, 300, 900]))
    const further = ownNav(view([-1200, -700, -10, 600]))
    expect([above.back, further.back]).toEqual([1, 2])
    expect(sameNav(above, further)).toBe(true)
    expect(sameNav(above, ownNav(view([300, 900])))).toBe(false)
  })
})

describe('own messages past the loaded rows', () => {
  it('offers a step back with no own message loaded once the server can find earlier ones', () => {
    const nav = ownNav(view([], { hasOlder: true, indexed: true }))
    expect(nav).toMatchObject({ show: true, back: 'older', forward: null })
    expect(ownNav(view([], { hasOlder: true })).show).toBe(false)
    expect(ownNav(view([200], { hasOlder: true, indexed: true })).show).toBe(true)
  })

  it('asks the server instead of walking pages when it can', () => {
    const indexed = { indexed: true, detached: false, pages: 10 }
    expect(ownMove('older', indexed)).toBe('find')
    expect(ownMove('older', { ...indexed, indexed: false })).toBe('walk')
    expect(ownMove('older', { ...indexed, indexed: false, pages: 0 })).toBe('stop')
    expect(ownMove(2, indexed)).toBe('land')
    expect(ownMove(null, indexed)).toBe('stop')
  })

  it('finds later own messages from a stretch far back, and goes to the newest otherwise', () => {
    expect(ownMove('latest', { indexed: true, detached: true, pages: 10 })).toBe('find')
    expect(ownMove('latest', { indexed: true, detached: false, pages: 10 })).toBe('latest')
    expect(ownMove('latest', { indexed: false, detached: true, pages: 10 })).toBe('latest')
  })

  it('stops offering earlier pages once the server finds no own message before the oldest row', () => {
    expect(olderOwn(true, 500, null)).toBe(true)
    expect(olderOwn(true, 500, 500)).toBe(false)
    expect(olderOwn(true, 400, 500)).toBe(false)
    expect(olderOwn(true, 600, 500)).toBe(true)
    expect(olderOwn(false, 600, null)).toBe(false)
  })
})

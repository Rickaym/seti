import { describe, expect, it, vi } from 'vitest'
import { swipeDirection, swipeTracker } from './swipe'

const touchAt = (x: number, y: number, timeStamp: number, fingers = 1) => {
  const point = { clientX: x, clientY: y }
  return { touches: Array.from({ length: fingers }, () => point), changedTouches: [point], target: null, timeStamp }
}

describe('swipeDirection', () => {
  it('reads a quick sideways move as a swipe', () => {
    expect(swipeDirection({ x: 20, y: 300 }, { x: 140, y: 320 }, 200)).toBe('right')
    expect(swipeDirection({ x: 200, y: 300 }, { x: 60, y: 290 }, 200)).toBe('left')
  })

  it('ignores short, slow and mostly vertical moves', () => {
    expect(swipeDirection({ x: 20, y: 300 }, { x: 70, y: 300 }, 200)).toBeNull()
    expect(swipeDirection({ x: 20, y: 300 }, { x: 200, y: 300 }, 1500)).toBeNull()
    expect(swipeDirection({ x: 20, y: 300 }, { x: 120, y: 420 }, 200)).toBeNull()
  })
})

describe('swipeTracker', () => {
  it('calls back once for a one-finger swipe in its direction', () => {
    const onSwipe = vi.fn()
    const tracker = swipeTracker('right', onSwipe, () => false)
    tracker.start(touchAt(20, 300, 0))
    tracker.end(touchAt(160, 310, 250))
    tracker.end(touchAt(160, 310, 260))
    expect(onSwipe).toHaveBeenCalledTimes(1)
  })

  it('skips the other direction, two fingers, ignored targets and cancelled touches', () => {
    const onSwipe = vi.fn()
    const tracker = swipeTracker('right', onSwipe, (event) => event.timeStamp === 1)
    tracker.start(touchAt(200, 300, 0))
    tracker.end(touchAt(40, 300, 200))
    tracker.start(touchAt(20, 300, 0, 2))
    tracker.end(touchAt(160, 300, 200))
    tracker.start(touchAt(20, 300, 1))
    tracker.end(touchAt(160, 300, 200))
    tracker.start(touchAt(20, 300, 0))
    tracker.cancel()
    tracker.end(touchAt(160, 300, 200))
    expect(onSwipe).not.toHaveBeenCalled()
  })
})

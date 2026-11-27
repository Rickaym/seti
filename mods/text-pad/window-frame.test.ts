import { describe, expect, it } from 'vitest'
import { clampFrame, firstFrame, frameOf, MIN_HEIGHT, MIN_WIDTH, moved, resized } from './window-frame.js'

const view = { width: 1440, height: 900 }
const frame = { x: 100, y: 200, width: 320, height: 360 }

describe('the pad window frame', () => {
  it('first opens beside the rail, near the bottom, inside the viewport', () => {
    expect(firstFrame(view)).toEqual({ x: 56, y: 492, width: 320, height: 360 })
    const small = firstFrame({ width: 400, height: 300 })
    expect(small.y).toBeGreaterThanOrEqual(8)
    expect(small.y + small.height).toBeLessThanOrEqual(292)
  })

  it('moves by a drag and stays wholly in view', () => {
    expect(moved(frame, 40, -20)).toEqual({ ...frame, x: 140, y: 180 })
    expect(clampFrame(moved(frame, 5000, 5000), view)).toEqual({ ...frame, x: 1112, y: 532 })
    expect(clampFrame(moved(frame, -5000, -5000), view)).toEqual({ ...frame, x: 8, y: 8 })
  })

  it('grows from the east and south and keeps the opposite sides from the west and north', () => {
    expect(resized(frame, 'se', 30, 40)).toEqual({ ...frame, width: 350, height: 400 })
    expect(resized(frame, 'nw', 30, 40)).toEqual({ x: 130, y: 240, width: 290, height: 320 })
  })

  it('never shrinks below its minimum, keeping the far side still', () => {
    expect(resized(frame, 'w', 1000, 0)).toEqual({ ...frame, x: 100 + 320 - MIN_WIDTH, width: MIN_WIDTH })
    expect(resized(frame, 's', 0, -1000)).toEqual({ ...frame, height: MIN_HEIGHT })
  })

  it('shrinks and moves into a smaller viewport, never off-screen', () => {
    const wide = { x: 1000, y: 500, width: 400, height: 380 }
    expect(clampFrame(wide, { width: 800, height: 600 })).toEqual({ x: 392, y: 212, width: 400, height: 380 })
    expect(clampFrame(wide, { width: 300, height: 200 })).toEqual({ x: 8, y: 8, width: 284, height: 184 })
  })

  it('reads back only a whole frame from storage', () => {
    expect(frameOf(frame)).toEqual(frame)
    expect(frameOf({ x: 1, y: 2, width: 'wide', height: 4 })).toBeNull()
    expect(frameOf(null)).toBeNull()
  })
})

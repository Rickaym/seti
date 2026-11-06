import { describe, expect, it } from 'vitest'
import { flings, flingStep, nextVelocity } from './touch-scroll'

describe('nextVelocity', () => {
  it('follows the drag, smoothed with the velocity before', () => {
    expect(nextVelocity(0, 10, 10)).toBeCloseTo(0.6)
    expect(nextVelocity(1, 10, 10)).toBeCloseTo(1)
    expect(nextVelocity(1, -20, 10)).toBeCloseTo(-0.8)
  })

  it('ignores a move with no time between', () => {
    expect(nextVelocity(0.5, 10, 0)).toBe(0.5)
  })
})

describe('flingStep', () => {
  it('slows each frame and scrolls by the speed it keeps', () => {
    const step = flingStep(2, 16)
    expect(step?.velocity).toBeCloseTo(1.9)
    expect(step?.delta).toBeCloseTo(30.4)
    expect(flingStep(-2, 32)?.velocity).toBeCloseTo(-1.805)
  })

  it('stops once it is slow, and a fast fling ends within a few seconds', () => {
    expect(flingStep(0.02, 16)).toBeNull()
    let velocity = 3
    let frames = 0
    for (let step = flingStep(velocity, 16); step !== null; step = flingStep(velocity, 16)) {
      velocity = step.velocity
      frames += 1
    }
    expect(frames * 16).toBeLessThan(3000)
  })
})

describe('flings', () => {
  it('flings on a quick lift and not after the finger rested', () => {
    expect(flings(1, 10)).toBe(true)
    expect(flings(-1, 10)).toBe(true)
    expect(flings(0.1, 10)).toBe(false)
    expect(flings(1, 200)).toBe(false)
  })
})

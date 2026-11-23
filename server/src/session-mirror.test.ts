import { describe, expect, it } from 'vitest'
import { autoQueueBlocker, isRunning, mirrorSession, sessionState } from './session-mirror.js'

const state = (over: Partial<Parameters<typeof mirrorSession>[1]> = {}) => ({
  type: 'session.changed' as const,
  open: true,
  running: true,
  accepting: true,
  autoQueued: false,
  background: 0,
  ...over,
})

describe('session mirror', () => {
  it('reads a session as its node last reported it', () => {
    mirrorSession('m1', state({ background: 2 }))
    expect(isRunning('m1')).toBe(true)
    expect(sessionState('m1')).toEqual({ open: true, background: 2 })
    mirrorSession('m1', state({ open: false, running: false, accepting: false }))
    expect(isRunning('m1')).toBe(false)
    expect(sessionState('m1')).toEqual({ open: false, background: 0 })
  })

  it('knows nothing of an agent without a session', () => {
    expect(isRunning('m2')).toBe(false)
    expect(sessionState('m2')).toEqual({ open: false, background: 0 })
    expect(autoQueueBlocker('m2')).toBeNull()
  })

  it('says why updates cannot queue for the running turn', () => {
    mirrorSession('m3', state({ accepting: false }))
    expect(autoQueueBlocker('m3')).toBe('The running turn is starting or being cut short')
    mirrorSession('m3', state({ autoQueued: true }))
    expect(autoQueueBlocker('m3')).toBe('Updates already wait for the running turn to end')
    expect(autoQueueBlocker('m3', true)).toBeNull()
    mirrorSession('m3', state())
    expect(autoQueueBlocker('m3')).toBeNull()
  })
})

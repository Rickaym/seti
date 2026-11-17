import { describe, expect, it, vi } from 'vitest'
import { createReach } from '@/lib/reach'

function watched() {
  let clock = 1000
  const reach = createReach(() => clock)
  const notified = vi.fn()
  reach.subscribe(notified)
  return {
    reach,
    notified,
    at: (time: number) => {
      clock = time
    },
  }
}

describe('createReach', () => {
  it('starts reached and stays quiet while polls are answered', () => {
    const { reach, notified } = watched()
    reach.answered()
    reach.answered()
    expect(reach.getSnapshot()).toEqual({ reconnecting: false, lastAnswer: null })
    expect(notified).not.toHaveBeenCalled()
  })

  it('reports one change however many polls go unanswered, with the time of the last answer', () => {
    const { reach, notified, at } = watched()
    reach.answered()
    at(2000)
    reach.unanswered(1500)
    at(3000)
    reach.unanswered(2500)
    reach.unanswered(2600)
    expect(reach.getSnapshot()).toEqual({ reconnecting: true, lastAnswer: 1000 })
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('clears on the first answer from any poller', () => {
    const { reach, notified, at } = watched()
    reach.unanswered(900)
    expect(reach.getSnapshot()).toEqual({ reconnecting: true, lastAnswer: null })
    at(4000)
    reach.answered()
    expect(reach.getSnapshot().reconnecting).toBe(false)
    expect(notified).toHaveBeenCalledTimes(2)
  })

  it('ignores a lost poll that another answer has outlived', () => {
    const { reach, notified, at } = watched()
    at(5000)
    reach.answered()
    at(9000)
    reach.unanswered(1000)
    expect(reach.getSnapshot().reconnecting).toBe(false)
    expect(notified).not.toHaveBeenCalled()
  })

  it('stops telling a listener that left', () => {
    const reach = createReach()
    const notified = vi.fn()
    reach.subscribe(notified)()
    reach.unanswered(0)
    expect(notified).not.toHaveBeenCalled()
  })
})

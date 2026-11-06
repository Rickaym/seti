import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelayedShow } from '@/lib/delayed-show'

describe('createDelayedShow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = () => {
    const changes: boolean[] = []
    const control = createDelayedShow({ delayMs: 150, minShownMs: 250 }, (shown) => {
      changes.push(shown)
    })
    return { control, changes }
  }

  it('never shows for a load quicker than the delay', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(149)
    control.set(false)
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
  })

  it('shows once the delay passes and hides as soon as the minimum time is up', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(150)
    expect(changes).toEqual([true])
    control.displayed()
    vi.advanceTimersByTime(50)
    control.set(false)
    expect(changes).toEqual([true])
    vi.advanceTimersByTime(199)
    expect(changes).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([true, false])
  })

  it('hides at once when loading ends after the minimum time', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(150)
    control.displayed()
    vi.advanceTimersByTime(450)
    control.set(false)
    expect(changes).toEqual([true, false])
  })

  it('stays shown when loading starts again during the minimum time', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(150)
    control.displayed()
    vi.advanceTimersByTime(50)
    control.set(false)
    vi.advanceTimersByTime(100)
    control.set(true)
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([true])
  })

  it('takes back a show that loading ended before it reached the screen', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(150)
    control.set(false)
    control.displayed()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([true, false])
  })

  it('restarts the delay for each new load and stops on dispose', () => {
    const { control, changes } = setup()
    control.set(true)
    vi.advanceTimersByTime(100)
    control.set(false)
    control.set(true)
    vi.advanceTimersByTime(100)
    expect(changes).toEqual([])
    control.dispose()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Link, LinkState } from '@/lib/link'

vi.mock('@/lib/app-link', () => ({ appLink: null }))

const { startPolling } = await import('@/lib/poll-loop')

const page = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() }

function fakeLink() {
  let state: LinkState = { online: true, slow: false, reason: null }
  const listeners = new Set<() => void>()
  const link: Link = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
  }
  const set = (change: Partial<LinkState>) => {
    state = { ...state, ...change }
    for (const listener of listeners) {
      listener()
    }
  }
  return { link, set, listeners }
}

describe('startPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('document', page)
    page.visibilityState = 'visible'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pauses while offline and polls at once on coming back online', async () => {
    const { link, set, listeners } = fakeLink()
    const run = vi.fn()
    const stop = startPolling(run, 1000, { link, leading: true })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(3)

    set({ online: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(3)

    set({ online: true })
    expect(run).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(5)

    stop()
    expect(listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('skips the leading run while offline', () => {
    const { link, set } = fakeLink()
    set({ online: false })
    const run = vi.fn()
    const stop = startPolling(run, 1000, { link, leading: true })
    expect(run).not.toHaveBeenCalled()
    stop()
  })

  it('waits four times the interval on a poor link and speeds up when it recovers', async () => {
    const { link, set } = fakeLink()
    const run = vi.fn()
    const stop = startPolling(run, 1000, { link })
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)

    set({ slow: true, reason: 'median round trip 900 ms' })
    await vi.advanceTimersByTimeAsync(3999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)

    set({ slow: false, reason: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(3)
    stop()
  })

  it('skips polls while hidden unless asked to keep going', async () => {
    const { link } = fakeLink()
    const shown = vi.fn()
    const always = vi.fn()
    const stopShown = startPolling(shown, 1000, { link })
    const stopAlways = startPolling(always, 1000, { link, whileHidden: true })
    page.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(3000)
    expect(shown).not.toHaveBeenCalled()
    expect(always).toHaveBeenCalledTimes(3)
    stopShown()
    stopAlways()
  })
})

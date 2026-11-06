import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** An Error fails the poll, `unchanged` answers 304, and anything else is a fresh body. */
const unchanged = Symbol('304')
const answers: unknown[] = []
const sentTags: (string | null)[] = []
let served = 0
vi.mock('@/lib/conditional-get', () => ({
  getIfChanged: vi.fn(async (_path: string, etag: string | null) => {
    sentTags.push(etag)
    const next = answers.shift()
    if (next instanceof Error) {
      return Promise.reject(next)
    }
    served += 1
    return Promise.resolve(next === unchanged ? null : { data: next, etag: `"v${String(served)}"` })
  }),
}))

const { createPolledResource } = await import('@/lib/polled')

const page = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() }

describe('createPolledResource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('document', page)
    page.visibilityState = 'visible'
    answers.length = 0
    sentTags.length = 0
    served = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const subscribed = () => {
    const resource = createPolledResource<{ items: { id: string; n: number }[] }>('/things', 1000)
    const notified = vi.fn()
    const stop = resource.subscribe(notified)
    return { resource, notified, stop }
  }

  it('notifies nobody when a poll brings the same data, and keeps its objects', async () => {
    answers.push({ items: [{ id: 'a', n: 1 }] }, { items: [{ id: 'a', n: 1 }] }, { items: [{ id: 'a', n: 2 }] })
    const { resource, notified, stop } = subscribed()
    await vi.advanceTimersByTimeAsync(0)
    const first = resource.getSnapshot()
    expect(notified).toHaveBeenCalledTimes(1)
    expect(first.lastOk).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1000)
    expect(notified).toHaveBeenCalledTimes(1)
    expect(resource.getSnapshot()).toBe(first)

    await vi.advanceTimersByTimeAsync(1000)
    expect(notified).toHaveBeenCalledTimes(2)
    expect(resource.getSnapshot().data?.items[0]?.n).toBe(2)
    stop()
  })

  it('reports a failure once, with the time of the latest answer, and the recovery', async () => {
    answers.push({ items: [] }, { items: [] }, new Error('down'), new Error('down'), { items: [] })
    const { resource, notified, stop } = subscribed()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    const latestOk = Date.now()
    await vi.advanceTimersByTimeAsync(1000)
    expect(resource.getSnapshot()).toMatchObject({ error: 'down', lastOk: latestOk })
    await vi.advanceTimersByTimeAsync(1000)
    expect(notified).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(resource.getSnapshot().error).toBeNull()
    expect(notified).toHaveBeenCalledTimes(3)
    stop()
  })

  it('skips polls while the page is hidden', async () => {
    answers.push({ items: [] }, { items: [{ id: 'b', n: 1 }] })
    const { resource, stop } = subscribed()
    await vi.advanceTimersByTimeAsync(0)
    page.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(5000)
    expect(answers).toHaveLength(1)
    page.visibilityState = 'visible'
    await vi.advanceTimersByTimeAsync(1000)
    expect(resource.getSnapshot().data?.items).toHaveLength(1)
    stop()
  })

  it('sends the tag it holds and keeps its data and objects on a 304', async () => {
    answers.push({ items: [{ id: 'a', n: 1 }] }, unchanged, { items: [{ id: 'a', n: 2 }] })
    const { resource, notified, stop } = subscribed()
    await vi.advanceTimersByTimeAsync(0)
    const first = resource.getSnapshot()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sentTags).toEqual([null, '"v1"'])
    expect(resource.getSnapshot()).toBe(first)
    expect(notified).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sentTags).toEqual([null, '"v1"', '"v1"'])
    expect(resource.getSnapshot().data?.items[0]?.n).toBe(2)
    stop()
  })

  it('clears a failure when the next poll answers 304', async () => {
    answers.push({ items: [] }, new Error('down'), unchanged)
    const { resource, stop } = subscribed()
    await vi.advanceTimersByTimeAsync(1000)
    expect(resource.getSnapshot().error).toBe('down')
    await vi.advanceTimersByTimeAsync(1000)
    expect(resource.getSnapshot()).toMatchObject({ error: null, data: { items: [] } })
    stop()
  })
})

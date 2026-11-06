import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openEventStream } from '@/lib/event-stream'

const opened: EventTarget[] = []

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = FakeEventSource.CONNECTING
  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    opened.push(this)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  emit(type: string, init: MessageEventInit<string> = {}): void {
    this.dispatchEvent(new MessageEvent(type, init))
  }

  /** What the browser does when the server answers with an error: close for good. */
  refuse(): void {
    this.readyState = FakeEventSource.CLOSED
    this.dispatchEvent(new Event('error'))
  }
}

const last = () => opened.at(-1) as FakeEventSource | undefined

beforeEach(() => {
  vi.useFakeTimers()
  opened.length = 0
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }),
  )
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('openEventStream', () => {
  it('reopens a refused stream after a pause, resuming after the last event it saw', () => {
    const seen: string[] = []
    const states: boolean[] = []
    const stream = openEventStream('/team/stream', {
      events: { message: (event) => seen.push(event.data) },
      onConnected: (connected) => states.push(connected),
    })
    expect(last()?.url).toBe('/api/team/stream')
    last()?.emit('open')
    last()?.emit('message', { data: 'hello', lastEventId: '41' })
    last()?.refuse()
    expect(opened).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(last()?.url).toBe('/api/team/stream?after=41')
    expect(seen).toEqual(['hello'])
    expect(states).toEqual([true, false])
    stream.close()
  })

  it('backs off between failed attempts and reconnects at once when asked', () => {
    const stream = openEventStream('/tasks/t1/stream?tail=1', { events: {} })
    last()?.refuse()
    vi.advanceTimersByTime(1000)
    last()?.refuse()
    vi.advanceTimersByTime(1999)
    expect(opened).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(opened).toHaveLength(3)
    stream.reconnect()
    expect(opened).toHaveLength(4)
    expect((opened[2] as FakeEventSource | undefined)?.readyState).toBe(FakeEventSource.CLOSED)
    stream.close()
  })

  it('closes a parked stream a minute after the page hides and resumes once it shows', () => {
    const states: boolean[] = []
    const stream = openEventStream(
      '/tasks/t1/stream',
      { events: { message: () => undefined }, onConnected: (connected) => states.push(connected) },
      { after: '7.ab.3', parkWhenHidden: true },
    )
    expect(last()?.url).toBe('/api/tasks/t1/stream?after=7.ab.3')
    last()?.emit('message', { data: 'row', lastEventId: '8.ab.5' })
    const hide = (state: string) => {
      Object.assign(document, { visibilityState: state })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    hide('hidden')
    vi.advanceTimersByTime(59_999)
    expect(last()?.readyState).not.toBe(FakeEventSource.CLOSED)
    vi.advanceTimersByTime(1)
    expect(last()?.readyState).toBe(FakeEventSource.CLOSED)
    expect(states).toEqual([false])
    hide('visible')
    expect(opened).toHaveLength(2)
    expect(last()?.url).toBe('/api/tasks/t1/stream?after=8.ab.5')
    stream.close()
  })

  it('drops the connection when the network goes and resumes when it returns', () => {
    const stream = openEventStream('/team/stream', { events: { message: () => undefined } })
    last()?.emit('message', { data: 'hi', lastEventId: '12' })
    window.dispatchEvent(new Event('offline'))
    expect(last()?.readyState).toBe(FakeEventSource.CLOSED)
    window.dispatchEvent(new Event('online'))
    expect(opened).toHaveLength(2)
    expect(last()?.url).toBe('/api/team/stream?after=12')
    stream.close()
  })

  it('leaves a transient drop to the browser and stops for good once closed', () => {
    const stream = openEventStream('/team/stream', { events: {} })
    last()?.dispatchEvent(new Event('error'))
    vi.advanceTimersByTime(60_000)
    expect(opened).toHaveLength(1)
    stream.close()
    last()?.refuse()
    vi.advanceTimersByTime(60_000)
    expect(opened).toHaveLength(1)
  })
})

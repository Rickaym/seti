import type { ModBridgeOut } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModBridge, openableRoute, type BridgeHost } from './bridge'

const NONCE = '4f1c2d3e-0000-4000-8000-000000000001'
const AGENT = '0b6f1c2d-1111-4222-8333-444455556666'

interface Fake {
  frame: Window
  /** What Seti sent the frame over its port. */
  received: ModBridgeOut[]
  ports: MessagePort[]
}

function fakeFrame(): Fake {
  const fake: Fake = { frame: {} as Window, received: [], ports: [] }
  fake.frame = {
    postMessage: (_message: unknown, _target: string, transfer: MessagePort[]) => {
      for (const port of transfer) {
        port.onmessage = (event: MessageEvent<ModBridgeOut>) => {
          fake.received.push(event.data)
        }
        fake.ports.push(port)
      }
    },
  } as unknown as Window
  return fake
}

function fakeHost(answer: BridgeHost['call'] = async () => Promise.resolve({ ok: true, value: 'done' })) {
  return {
    call: vi.fn(answer),
    resize: vi.fn(),
    open: vi.fn(),
    link: vi.fn(),
    ready: vi.fn(),
    report: vi.fn(),
  } satisfies BridgeHost
}

const hello = (source: unknown, nonce = NONCE, origin = 'null') => ({
  data: { seti: 'mod-hello', v: 1, nonce },
  origin,
  source: source as MessageEventSource,
})

const open: { bridge: ModBridge; fake: Fake }[] = []

function connected(host: BridgeHost = fakeHost(), clock = { now: 0 }) {
  const fake = fakeFrame()
  const bridge = new ModBridge(NONCE, 'linear', host, () => clock.now)
  expect(bridge.hello(hello(fake.frame), fake.frame)).toBe(true)
  open.push({ bridge, fake })
  return { bridge, fake, clock }
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

afterEach(() => {
  for (const { bridge, fake } of open.splice(0)) {
    bridge.close()
    for (const port of fake.ports) {
      port.close()
    }
  }
})

describe('the bridge handshake', () => {
  it('hands the port only to its own frame, with its nonce, from an opaque origin, once', () => {
    const fake = fakeFrame()
    const other = fakeFrame()
    const bridge = new ModBridge(NONCE, 'linear', fakeHost())
    open.push({ bridge, fake })
    expect(bridge.hello(hello(other.frame), fake.frame)).toBe(false)
    expect(bridge.hello(hello(fake.frame, '4f1c2d3e-0000-4000-8000-000000000002'), fake.frame)).toBe(false)
    expect(bridge.hello(hello(fake.frame, NONCE, 'http://localhost:3006'), fake.frame)).toBe(false)
    expect(bridge.hello({ ...hello(fake.frame), data: { seti: 'mod-hello', v: 2, nonce: NONCE } }, fake.frame)).toBe(
      false,
    )
    expect(bridge.hello(hello(fake.frame), null)).toBe(false)
    expect(fake.ports).toHaveLength(0)
    expect(bridge.hello(hello(fake.frame), fake.frame)).toBe(true)
    expect(fake.ports).toHaveLength(1)
    expect(bridge.hello(hello(fake.frame), fake.frame)).toBe(false)
    expect(fake.ports).toHaveLength(1)
  })

  it('closes when the frame loads a second page, and hands nothing to the page it navigated to', () => {
    const host = fakeHost()
    const fake = fakeFrame()
    const bridge = new ModBridge(NONCE, 'linear', host)
    open.push({ bridge, fake })
    bridge.loaded()
    bridge.loaded()
    expect(host.report).toHaveBeenCalledWith('navigated', true)
    expect(bridge.hello(hello(fake.frame), fake.frame)).toBe(false)
  })
})

describe('bridge messages', () => {
  it('relays calls and answers each over the port, refusing past eight in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = fakeHost(async () => {
      await gate
      return { ok: true as const, value: 'done' }
    })
    const { bridge, fake } = connected(host)
    for (let id = 1; id <= 9; id++) {
      bridge.receive({ t: 'call', id, op: 'settings.get' })
    }
    bridge.receive({ t: 'call', id: 1, op: 'settings.get' })
    await settle()
    expect(host.call).toHaveBeenCalledTimes(8)
    expect(fake.received).toEqual([
      { t: 'result', id: 9, ok: false, error: { code: 'limit', message: 'At most 8 calls wait at once' } },
    ])
    release()
    await settle()
    expect(fake.received.filter((message) => message.t === 'result' && message.ok)).toHaveLength(8)
  })

  it('passes a refusal from Seti back to the view', async () => {
    const host = fakeHost(async () =>
      Promise.resolve({ ok: false as const, error: { code: 'denied' as const, message: 'No' } }),
    )
    const { bridge, fake } = connected(host)
    bridge.receive({ t: 'call', id: 3, op: 'command', command: 'sync' })
    await settle()
    expect(fake.received).toEqual([{ t: 'result', id: 3, ok: false, error: { code: 'denied', message: 'No' } }])
  })

  it('drops what the bridge does not take, reporting it once without closing', async () => {
    const host = fakeHost()
    const { bridge, fake } = connected(host)
    for (const message of [
      { t: 'call', id: 1, op: 'net.fetch', url: 'https://example.test' },
      { t: 'call', id: 2, op: 'storage.get', key: 'k', modId: 'other' },
      { t: 'call', id: 3, op: 'tasks.list' },
      { t: 'resize', height: 'tall' },
      { t: 'link', url: 'http://example.test' },
      { t: 'open', to: '#settings/credentials' },
      'hello',
    ]) {
      bridge.receive(message)
    }
    bridge.receive({ t: 'call', id: 4, op: 'storage.get', key: 'k' })
    await settle()
    expect(host.call).toHaveBeenCalledTimes(1)
    expect(host.open).not.toHaveBeenCalled()
    expect(host.link).not.toHaveBeenCalled()
    expect(host.report.mock.calls).toEqual([['malformed', false]])
    expect(fake.received).toEqual([{ t: 'result', id: 4, ok: true, value: 'done' }])
  })

  it('closes after three messages over 64 KB', () => {
    const host = fakeHost()
    const { bridge } = connected(host)
    const big = { t: 'call', id: 1, op: 'storage.set', key: 'k', value: 'x'.repeat(70_000) }
    bridge.receive(big)
    bridge.receive(big)
    expect(bridge.connected).toBe(true)
    bridge.receive(big)
    expect(bridge.connected).toBe(false)
    expect(host.report).toHaveBeenCalledWith('oversized', true)
  })

  it('closes a view that floods it, past a burst of 30 at 10 a second', () => {
    const host = fakeHost()
    const { bridge, clock } = connected(host)
    for (let id = 1; id <= 30; id++) {
      bridge.receive({ t: 'ready' })
    }
    clock.now = 100
    bridge.receive({ t: 'ready' })
    expect(bridge.connected).toBe(true)
    for (let id = 1; id <= 70; id++) {
      bridge.receive({ t: 'ready' })
    }
    expect(bridge.connected).toBe(false)
    expect(host.ready).toHaveBeenCalledTimes(31)
    expect(host.report).toHaveBeenCalledWith('flooded', true)
  })

  it('clamps resizes to 48..1600 at four a second, and opens only Seti routes it may', () => {
    const host = fakeHost()
    const { bridge, clock } = connected(host)
    for (const height of [10, 5000, 300, 400, 500]) {
      bridge.receive({ t: 'resize', height })
    }
    expect(host.resize.mock.calls).toEqual([[48], [1600], [300], [400]])
    clock.now = 1000
    bridge.receive({ t: 'open', to: `#agents/${AGENT}` })
    bridge.receive({ t: 'link', url: 'https://example.test/x' })
    expect(host.open).toHaveBeenCalledWith(`#agents/${AGENT}`)
    expect(host.link).toHaveBeenCalledWith('https://example.test/x')
  })
})

describe('routes a view may open', () => {
  it.each([
    ['#agents', true],
    [`#agents/${AGENT}`, true],
    ['#linear.board', true],
    ['#other.board', false],
    ['#settings/credentials', false],
    [`#agents/${AGENT}/../settings`, false],
    ['#linear.board/../../settings', false],
  ])('%s: %s', (route, allowed) => {
    expect(openableRoute(route, 'linear')).toBe(allowed)
  })
})

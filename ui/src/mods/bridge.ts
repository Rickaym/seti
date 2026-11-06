import {
  MOD_BRIDGE_LIMITS,
  MOD_BRIDGE_VERSION,
  modBridgeIn,
  modHello,
  type ModBridgeCall,
  type ModBridgeOut,
  type ModError,
  type ModFrameReportInput,
} from '@seti/shared'

type Answer = { ok: true; value: unknown } | { ok: false; error: ModError }

/** What the bridge asks of the page that holds the frame. */
export interface BridgeHost {
  call: (call: ModBridgeCall) => Promise<Answer>
  resize: (height: number) => void
  open: (route: string) => void
  link: (url: string) => void
  ready: () => void
  /** The view misbehaved; `stopped` says whether the bridge closed for it. */
  report: (reason: ModFrameReportInput['reason'], stopped: boolean) => void
}

/** Seti routes a view may open: the agents, one agent, the EA and its own mod's sections. */
export function openableRoute(route: string, modId: string): boolean {
  const own = route.startsWith(`#${modId}.`) && /^#[a-z0-9-]+\.[a-z][a-z0-9_-]*$/.test(route)
  return own || /^#(?:agents|ea|context)$/.test(route) || /^#agents\/[0-9a-f-]{36}$/.test(route)
}

/** Tokens refill at `rate` a second up to `burst`; each message takes one. */
class Bucket {
  private readonly rate: number
  private readonly burst: number
  private tokens: number
  private last: number

  constructor(rate: number, burst: number, now: number) {
    this.rate = rate
    this.burst = burst
    this.tokens = burst
    this.last = now
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
    if (this.tokens < 1) {
      return false
    }
    this.tokens -= 1
    return true
  }
}

const clamp = (height: number) =>
  Math.min(MOD_BRIDGE_LIMITS.resizeMax, Math.max(MOD_BRIDGE_LIMITS.resizeMin, Math.round(height)))

const sizeOf = (data: unknown): number | null => {
  try {
    return (JSON.stringify(data) as string | undefined)?.length ?? 0
  } catch {
    return null
  }
}

/**
 * Seti's end of one frame's bridge. The frame says hello on the window once; the bridge checks
 * that it came from this frame (every sandboxed frame's origin is "null", so the source decides),
 * with this frame's nonce, on the first load, and hands over a port. After that the window is
 * ignored, and every port message is size-checked, rate-limited and parsed before it acts.
 */
export class ModBridge {
  private loads = 0
  private port: MessagePort | null = null
  private handed = false
  private closed = false
  private violations = 0
  private malformed = false
  private readonly inFlight = new Set<number>()
  private readonly messages: Bucket
  private readonly resizes: Bucket
  private readonly nonce: string
  private readonly modId: string
  private readonly host: BridgeHost
  private readonly now: () => number

  constructor(nonce: string, modId: string, host: BridgeHost, now: () => number = () => performance.now()) {
    this.nonce = nonce
    this.modId = modId
    this.host = host
    this.now = now
    this.messages = new Bucket(MOD_BRIDGE_LIMITS.ratePerSecond, MOD_BRIDGE_LIMITS.burst, now())
    this.resizes = new Bucket(MOD_BRIDGE_LIMITS.resizesPerSecond, MOD_BRIDGE_LIMITS.resizesPerSecond, now())
  }

  /** The frame finished a load; a second load means it navigated away, which ends the bridge. */
  loaded(): void {
    this.loads += 1
    if (this.loads > 1) {
      this.stop('navigated')
    }
  }

  /** A window message; hands the port over when it is this frame's hello. Returns whether it did. */
  hello(event: Pick<MessageEvent, 'data' | 'origin' | 'source'>, frame: Window | null): boolean {
    if (this.handed || this.closed || frame === null || event.source !== frame || event.origin !== 'null') {
      return false
    }
    const hello = modHello.safeParse(event.data)
    if (!hello.success || hello.data.nonce !== this.nonce || this.loads > 1) {
      return false
    }
    const channel = new MessageChannel()
    this.port = channel.port1
    this.port.onmessage = (message) => {
      this.receive(message.data)
    }
    this.handed = true
    // eslint-disable-next-line sonarjs/post-message -- an opaque frame has no origin to name; the port goes to its window
    frame.postMessage({ seti: 'mod-port', v: MOD_BRIDGE_VERSION, nonce: this.nonce }, '*', [channel.port2])
    return true
  }

  get connected(): boolean {
    return this.port !== null && !this.closed
  }

  send(message: ModBridgeOut): void {
    if (this.connected) {
      this.port?.postMessage(message)
    }
  }

  close(): void {
    this.closed = true
    this.port?.close()
    this.port = null
  }

  /** One message from the frame's port. */
  receive(data: unknown): void {
    if (this.closed) {
      return
    }
    const size = sizeOf(data)
    if (size === null || size > MOD_BRIDGE_LIMITS.messageBytes) {
      this.violate('oversized')
      return
    }
    if (!this.messages.take(this.now())) {
      this.violate('flooded')
      return
    }
    const parsed = modBridgeIn.safeParse(data)
    if (!parsed.success) {
      this.dropMalformed()
      return
    }
    const message = parsed.data
    switch (message.t) {
      case 'call':
        this.call(message)
        return
      case 'resize':
        if (this.resizes.take(this.now())) {
          this.host.resize(clamp(message.height))
        }
        return
      case 'open':
        if (openableRoute(message.to, this.modId)) {
          this.host.open(message.to)
        } else {
          this.dropMalformed()
        }
        return
      case 'link':
        this.host.link(message.url)
        return
      case 'ready':
        this.host.ready()
    }
  }

  private call(call: ModBridgeCall): void {
    if (this.inFlight.has(call.id)) {
      return
    }
    if (this.inFlight.size >= MOD_BRIDGE_LIMITS.inFlight) {
      const message = `At most ${String(MOD_BRIDGE_LIMITS.inFlight)} calls wait at once`
      this.send({ t: 'result', id: call.id, ok: false, error: { code: 'limit', message } })
      return
    }
    this.inFlight.add(call.id)
    void this.host
      .call(call)
      .catch((e: unknown): Answer => ({ ok: false, error: { code: 'failed', message: String(e) } }))
      .then((answer) => {
        this.inFlight.delete(call.id)
        this.send(
          answer.ok
            ? { t: 'result', id: call.id, ok: true, value: answer.value }
            : { t: 'result', id: call.id, ...answer },
        )
      })
  }

  private dropMalformed(): void {
    if (!this.malformed) {
      this.malformed = true
      this.host.report('malformed', false)
    }
  }

  private violate(reason: 'oversized' | 'flooded'): void {
    this.violations += 1
    if (this.violations >= MOD_BRIDGE_LIMITS.violations) {
      this.stop(reason)
    }
  }

  private stop(reason: ModFrameReportInput['reason']): void {
    if (this.closed) {
      return
    }
    this.close()
    this.host.report(reason, true)
  }
}

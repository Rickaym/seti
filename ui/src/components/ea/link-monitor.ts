/** Tells the call when its network path drops and when a rebuilt one connects. */
export class LinkMonitor {
  private reconnecting = false
  private readonly report: (reconnecting: boolean) => void

  constructor(report: (reconnecting: boolean) => void) {
    this.report = report
  }

  /** The transport gave up on the path and is building a new peer connection. */
  readonly rebuilding = (): void => {
    this.set(true)
  }

  /** The peer connection's states, read once a second. */
  readonly observe = (state: RTCPeerConnectionState | undefined, ice: RTCIceConnectionState | undefined): void => {
    if (state === 'connected') {
      this.set(false)
    } else if (ice === 'disconnected' || ice === 'failed') {
      this.set(true)
    }
  }

  private set(reconnecting: boolean): void {
    if (reconnecting !== this.reconnecting) {
      this.reconnecting = reconnecting
      this.report(reconnecting)
    }
  }
}

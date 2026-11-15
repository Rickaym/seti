/** How long the device list must stay still before a call follows it; a headset lists in steps. */
export const SETTLE_MS = 1500
/** Device changes this soon after a reopen count as its echo, not as a new headset. */
export const QUIET_MS = 3000

type Later = (task: () => void, ms: number) => () => void

export interface RerouteDeps {
  /** Reopens the microphone, hands the new track to the call and replays the EA's voice. */
  run: () => Promise<void>
  later: Later
  now: () => number
  /** Counts a reroute that finished. */
  rerouted: () => void
}

/**
 * Moves a live call to whatever the phone routes to now. Chrome on Android picks a Bluetooth
 * headset only when a microphone opens, so a headset that connects or wakes mid-call needs the
 * microphone reopened. One settled change in the device list gives one reroute, and a reroute's
 * own echo gives none.
 */
export class Rerouter {
  private readonly deps: RerouteDeps
  private devices: string | null = null
  private pending: (() => void) | null = null
  private running: Promise<boolean> | null = null
  private quietUntil = 0
  private stopped = false

  constructor(deps: RerouteDeps) {
    this.deps = deps
  }

  private cancel(): void {
    this.pending?.()
    this.pending = null
  }

  /** Takes the device list's signature; the first one seen is the baseline. */
  readonly devicesChanged = (signature: string): void => {
    const previous = this.devices
    this.devices = signature
    if (previous === null || previous === signature || this.stopped) {
      return
    }
    if (this.running !== null || this.deps.now() < this.quietUntil) {
      return
    }
    this.cancel()
    this.pending = this.deps.later(() => {
      this.pending = null
      void this.reroute()
    }, SETTLE_MS)
  }

  /** The user's own microphone switch reopens the call already, so a pending reroute is moot. */
  readonly switched = (): void => {
    this.cancel()
    this.quietUntil = this.deps.now() + QUIET_MS
  }

  /** Reroutes now; a second press while one runs joins it. Resolves to whether it worked. */
  readonly reroute = async (): Promise<boolean> => {
    if (this.stopped) {
      return false
    }
    if (this.running !== null) {
      return this.running
    }
    this.cancel()
    const run = this.deps.run().then(
      () => {
        this.deps.rerouted()
        return true
      },
      () => false,
    )
    this.running = run.finally(() => {
      this.running = null
      this.quietUntil = this.deps.now() + QUIET_MS
    })
    return this.running
  }

  readonly stop = (): void => {
    this.stopped = true
    this.cancel()
  }
}

export interface HandOver {
  /** Stops the open microphone and opens it again, so the browser picks the device afresh. */
  reopen: () => Promise<void>
  micOn: () => boolean
  track: () => MediaStreamTrack | null
  sender: () => Pick<RTCRtpSender, 'replaceTrack'> | null
  /** Re-attaches the EA's voice so its output stream opens on the current route. */
  reattach: () => void
}

/** Reopens the microphone and sends its new track; a muted call sends it once unmuted. */
export async function handOver({ reopen, micOn, track, sender, reattach }: HandOver): Promise<void> {
  await reopen()
  if (micOn()) {
    const opened = track()
    if (opened === null || opened.readyState === 'ended') {
      throw new Error('The microphone did not reopen')
    }
    await sender()?.replaceTrack(opened)
  }
  reattach()
}

type DeviceInfo = Pick<MediaDeviceInfo, 'deviceId' | 'kind'>

/** The audio devices the browser lists, as one string that changes when one comes or goes. */
export const deviceSignature = (devices: readonly DeviceInfo[]): string =>
  devices
    .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
    .map((device) => `${device.kind}:${device.deviceId}`)
    .sort((a, b) => a.localeCompare(b))
    .join(',')

type MediaLike = Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>

/** Hands each device list's signature to `onChange`, now and on every change; returns the stop. */
export function watchDevices(media: MediaLike, onChange: (signature: string) => void): () => void {
  let latest = 0
  let stopped = false
  const list = () => {
    latest += 1
    const current = latest
    media.enumerateDevices().then(
      (devices) => {
        if (!stopped && current === latest) {
          onChange(deviceSignature(devices))
        }
      },
      () => undefined,
    )
  }
  list()
  media.addEventListener('devicechange', list)
  return () => {
    stopped = true
    media.removeEventListener('devicechange', list)
  }
}

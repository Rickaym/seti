import {
  deviceList,
  lostDevices,
  micConstraints,
  parseAudioPrefs,
  resolveDevice,
  type AudioPrefs,
  type DeviceList,
  type PrefsStorage,
  type Processing,
  type Resolved,
  type SavedDevice,
} from './audio-prefs'

type MediaDevicesLike = Pick<
  MediaDevices,
  'enumerateDevices' | 'getUserMedia' | 'addEventListener' | 'removeEventListener'
>

export interface AudioDeps {
  /** Null where the page cannot use media devices at all. */
  media: MediaDevicesLike | null
  storage: PrefsStorage
  sinkSupported: boolean
  /** Whether a call uses the devices now, so that losing one deserves a toast. */
  inUse: () => boolean
  onLost: (message: string) => void
  describeError: (error: unknown) => string
}

export interface AudioState extends DeviceList {
  prefs: AudioPrefs
  mic: Resolved
  speaker: Resolved
  sinkSupported: boolean
  /** Why the microphone could not be opened to list devices, or null. */
  blocked: string | null
}

const EMPTY_LIST: DeviceList = { listed: false, mics: [], speakers: [] }

function derive(list: DeviceList, prefs: AudioPrefs, sinkSupported: boolean, blocked: string | null): AudioState {
  return {
    ...list,
    prefs,
    mic: resolveDevice(prefs.mic, list.mics, list.listed),
    speaker: resolveDevice(prefs.speaker, list.speakers, list.listed),
    sinkSupported,
    blocked,
  }
}

export function lostMessage(labels: readonly string[]): string {
  return `${labels.join(' and ')} disconnected. The EA uses the system default now.`
}

/** The EA's microphone and speaker choices in this browser, following devices as they change. */
export class AudioDeviceStore {
  private state: AudioState
  private readonly listeners = new Set<() => void>()
  private readonly deps: AudioDeps
  private listing = 0

  constructor(deps: AudioDeps) {
    this.deps = deps
    this.state = derive(EMPTY_LIST, parseAudioPrefs(deps.storage.read()), deps.sinkSupported, null)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): AudioState => this.state

  private set(next: AudioState): void {
    this.state = next
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** Lists devices now and whenever they change; returns the way to stop. */
  readonly start = (): (() => void) => {
    const media = this.deps.media
    void this.refresh()
    if (media === null) {
      return () => undefined
    }
    const onChange = () => {
      void this.refresh()
    }
    media.addEventListener('devicechange', onChange)
    return () => {
      media.removeEventListener('devicechange', onChange)
    }
  }

  readonly refresh = async (): Promise<void> => {
    const media = this.deps.media
    if (media === null) {
      return
    }
    this.listing += 1
    const current = this.listing
    const devices = await media.enumerateDevices().catch(() => [])
    if (current !== this.listing) {
      return
    }
    const before = this.state
    const next = derive(deviceList(devices), before.prefs, before.sinkSupported, before.blocked)
    const lost = lostDevices([before.mic, before.speaker], [next.mic, next.speaker])
    this.set(next)
    if (lost.length > 0 && this.deps.inUse()) {
      this.deps.onLost(lostMessage(lost))
    }
  }

  /** Opens the microphone once so the browser shows device names, then lists them. */
  readonly allow = async (): Promise<void> => {
    const media = this.deps.media
    if (media === null) {
      return
    }
    try {
      const stream = await media.getUserMedia({ audio: this.micConstraints() })
      for (const track of stream.getTracks()) {
        track.stop()
      }
      this.set({ ...this.state, blocked: null })
    } catch (e) {
      this.set({ ...this.state, blocked: this.deps.describeError(e) })
    }
    await this.refresh()
  }

  readonly micConstraints = (): MediaTrackConstraints => micConstraints(this.state.prefs, this.state.mic.id)

  private save(prefs: AudioPrefs): void {
    this.deps.storage.write(JSON.stringify(prefs))
    const { listed, mics, speakers, sinkSupported, blocked } = this.state
    this.set(derive({ listed, mics, speakers }, prefs, sinkSupported, blocked))
  }

  private chosen(id: string | null, available: readonly { id: string; label: string }[]): SavedDevice | null {
    return available.find((device) => device.id === id) ?? null
  }

  readonly chooseMic = (id: string | null): void => {
    this.save({ ...this.state.prefs, mic: this.chosen(id, this.state.mics) })
  }

  readonly chooseSpeaker = (id: string | null): void => {
    this.save({ ...this.state.prefs, speaker: this.chosen(id, this.state.speakers) })
  }

  readonly setProcessing = (key: Processing, on: boolean): void => {
    this.save({ ...this.state.prefs, [key]: on })
  }
}

/** What a live call must reopen the microphone for: the device in use and its processing. */
export const micKey = ({ mic, prefs }: AudioState): string =>
  [mic.id ?? '', prefs.echoCancellation, prefs.noiseSuppression, prefs.autoGainControl].join('|')

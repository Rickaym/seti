/** A device the user chose, with its label for when it is not connected. */
export interface SavedDevice {
  id: string
  label: string
}

export type Processing = 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'

export const PROCESSING: readonly Processing[] = ['echoCancellation', 'noiseSuppression', 'autoGainControl']

/** This browser's EA audio choices; a null device follows the system default. */
export interface AudioPrefs extends Record<Processing, boolean> {
  mic: SavedDevice | null
  speaker: SavedDevice | null
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  mic: null,
  speaker: null,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

const PREFS_KEY = 'seti-ea-audio'

function savedDevice(value: unknown): SavedDevice | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, label } = value as Record<string, unknown>
  return typeof id === 'string' && id !== '' && typeof label === 'string' ? { id, label } : null
}

/** Reads stored choices leniently: anything unreadable keeps its default. */
export function parseAudioPrefs(raw: string | null): AudioPrefs {
  let value: unknown = null
  try {
    value = raw === null ? null : JSON.parse(raw)
  } catch {
    return DEFAULT_AUDIO_PREFS
  }
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_AUDIO_PREFS
  }
  const record = value as Record<string, unknown>
  const flag = (key: Processing) => {
    const stored = record[key]
    return typeof stored === 'boolean' ? stored : DEFAULT_AUDIO_PREFS[key]
  }
  return {
    mic: savedDevice(record.mic),
    speaker: savedDevice(record.speaker),
    echoCancellation: flag('echoCancellation'),
    noiseSuppression: flag('noiseSuppression'),
    autoGainControl: flag('autoGainControl'),
  }
}

export interface PrefsStorage {
  read: () => string | null
  write: (value: string) => void
}

export const browserPrefsStorage: PrefsStorage = {
  read: () => {
    try {
      return localStorage.getItem(PREFS_KEY)
    } catch {
      return null
    }
  },
  write: (value) => {
    try {
      localStorage.setItem(PREFS_KEY, value)
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  },
}

export interface DeviceOption {
  id: string
  label: string
}

export interface DeviceList {
  /** Labels show only once the page may use the microphone; before that nothing can be chosen. */
  listed: boolean
  mics: DeviceOption[]
  speakers: DeviceOption[]
}

type DeviceInfo = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

/** Entries that stand for another device, which the "System default" option covers. */
const ALIASES = new Set(['', 'default', 'communications'])

function options(devices: readonly DeviceInfo[], kind: MediaDeviceKind, noun: string): DeviceOption[] {
  return devices
    .filter((device) => device.kind === kind && !ALIASES.has(device.deviceId))
    .map((device, i) => ({
      id: device.deviceId,
      label: device.label === '' ? `${noun} ${String(i + 1)}` : device.label,
    }))
}

export function deviceList(devices: readonly DeviceInfo[]): DeviceList {
  return {
    listed: devices.some((device) => device.kind === 'audioinput' && device.label !== ''),
    mics: options(devices, 'audioinput', 'Microphone'),
    speakers: options(devices, 'audiooutput', 'Speaker'),
  }
}

/** The device a choice uses now: null is the system default, with the saved one when it is gone. */
export interface Resolved {
  id: string | null
  missing: SavedDevice | null
}

/** Browsers can change device ids between visits, so a saved device is also found by label. */
export function resolveDevice(
  saved: SavedDevice | null,
  available: readonly DeviceOption[],
  listed: boolean,
): Resolved {
  if (saved === null) {
    return { id: null, missing: null }
  }
  if (!listed) {
    return { id: null, missing: null }
  }
  const match =
    available.find((device) => device.id === saved.id) ?? available.find((device) => device.label === saved.label)
  return match === undefined ? { id: null, missing: saved } : { id: match.id, missing: null }
}

/** Devices that were in use and are gone now, each named once. */
export function lostDevices(before: readonly Resolved[], after: readonly Resolved[]): string[] {
  const labels = after.flatMap((now, i) => {
    const was = before[i]
    return (was?.id ?? null) !== null && now.missing !== null ? [now.missing.label] : []
  })
  return [...new Set(labels)]
}

export function micConstraints(prefs: AudioPrefs, micId: string | null): MediaTrackConstraints {
  return {
    ...(micId === null ? {} : { deviceId: { exact: micId } }),
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
  }
}

/** Fills in the chosen microphone and processing where an audio request leaves them unset. */
export function withMicDefaults(
  request: MediaStreamConstraints | undefined,
  defaults: MediaTrackConstraints,
): MediaStreamConstraints | undefined {
  const audio = request?.audio
  if (audio === undefined || audio === false) {
    return request
  }
  return { ...request, audio: audio === true ? defaults : { ...defaults, ...audio } }
}

/** Whether media elements can play to a chosen output; iOS Safari and older Firefox cannot. */
export const canSetSink = (prototype: object | undefined): boolean =>
  prototype !== undefined && 'setSinkId' in prototype

/** The output picker needs sink support and a listed speaker; Firefox lists none without asking. */
export const outputChoice = (sinkSupported: boolean, list: DeviceList): boolean =>
  sinkSupported && list.listed && list.speakers.length > 0

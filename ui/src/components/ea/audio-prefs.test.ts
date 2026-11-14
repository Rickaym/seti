import { describe, expect, it } from 'vitest'
import {
  canSetSink,
  DEFAULT_AUDIO_PREFS,
  deviceList,
  lostDevices,
  micConstraints,
  outputChoice,
  parseAudioPrefs,
  phoneOutput,
  resolveDevice,
  withMicDefaults,
} from './audio-prefs'

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label })

const CHROME = [
  device('audioinput', 'default', 'Default - Desk Mic'),
  device('audioinput', 'communications', 'Communications - Desk Mic'),
  device('audioinput', 'desk', 'Desk Mic'),
  device('audioinput', 'usb', 'USB Headset'),
  device('videoinput', 'cam', 'Camera'),
  device('audiooutput', 'default', 'Default - Speakers'),
  device('audiooutput', 'speakers', 'Speakers'),
  device('audiooutput', 'usb-out', 'USB Headset'),
]

describe('parseAudioPrefs', () => {
  it('reads saved choices and keeps defaults for what is missing or malformed', () => {
    const raw = JSON.stringify({
      mic: { id: 'usb', label: 'USB Headset' },
      speaker: { id: '' },
      noiseSuppression: false,
    })
    expect(parseAudioPrefs(raw)).toEqual({
      ...DEFAULT_AUDIO_PREFS,
      mic: { id: 'usb', label: 'USB Headset' },
      noiseSuppression: false,
    })
  })

  it('falls back to the defaults for nothing stored or unreadable JSON', () => {
    expect(parseAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS)
    expect(parseAudioPrefs('{not json')).toEqual(DEFAULT_AUDIO_PREFS)
    expect(parseAudioPrefs('"text"')).toEqual(DEFAULT_AUDIO_PREFS)
  })
})

describe('deviceList', () => {
  it('lists real devices only, since "System default" covers the aliases', () => {
    expect(deviceList(CHROME)).toEqual({
      listed: true,
      mics: [
        { id: 'desk', label: 'Desk Mic' },
        { id: 'usb', label: 'USB Headset' },
      ],
      speakers: [
        { id: 'speakers', label: 'Speakers' },
        { id: 'usb-out', label: 'USB Headset' },
      ],
    })
  })

  it('is not listed before the microphone is allowed, when labels are empty', () => {
    const hidden = [device('audioinput', '', ''), device('audiooutput', '', '')]
    expect(deviceList(hidden)).toEqual({ listed: false, mics: [], speakers: [] })
  })

  it('names devices without a label by their place', () => {
    const list = deviceList([device('audioinput', 'a', 'Mic'), device('audiooutput', 'b', '')])
    expect(list.speakers).toEqual([{ id: 'b', label: 'Speaker 1' }])
  })
})

describe('resolveDevice', () => {
  const { mics } = deviceList(CHROME)

  it('uses a saved device that is connected', () => {
    expect(resolveDevice({ id: 'usb', label: 'USB Headset' }, mics, true)).toEqual({ id: 'usb', missing: null })
  })

  it('finds the saved device by its label when the browser changed its id', () => {
    expect(resolveDevice({ id: 'old-id', label: 'USB Headset' }, mics, true)).toEqual({ id: 'usb', missing: null })
  })

  it('falls back to the system default when the saved device is gone, and says which it was', () => {
    const saved = { id: 'gone', label: 'Old Mic' }
    expect(resolveDevice(saved, mics, true)).toEqual({ id: null, missing: saved })
  })

  it('follows the system default until devices can be listed, without calling the saved one gone', () => {
    expect(resolveDevice({ id: 'usb', label: 'USB Headset' }, [], false)).toEqual({ id: null, missing: null })
  })

  it('follows the system default when nothing is saved', () => {
    expect(resolveDevice(null, mics, true)).toEqual({ id: null, missing: null })
  })
})

describe('lostDevices', () => {
  it('names each device that was in use and is gone, once', () => {
    const headset = { id: 'usb', label: 'USB Headset' }
    const before = [
      { id: 'usb', missing: null },
      { id: 'usb-out', missing: null },
    ]
    const after = [
      { id: null, missing: headset },
      { id: null, missing: { id: 'usb-out', label: 'USB Headset' } },
    ]
    expect(lostDevices(before, after)).toEqual(['USB Headset'])
  })

  it('stays quiet when the device was already gone or still is', () => {
    const gone = { id: null, missing: { id: 'usb', label: 'USB Headset' } }
    expect(lostDevices([gone], [gone])).toEqual([])
    expect(lostDevices([{ id: 'usb', missing: null }], [{ id: 'usb', missing: null }])).toEqual([])
  })
})

describe('microphone constraints', () => {
  const prefs = { ...DEFAULT_AUDIO_PREFS, echoCancellation: false }

  it('asks for the chosen device and processing', () => {
    expect(micConstraints(prefs, 'usb')).toEqual({
      deviceId: { exact: 'usb' },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    })
    expect(micConstraints(prefs, null)).not.toHaveProperty('deviceId')
  })

  it('fills a bare request and lets an explicit device win', () => {
    const defaults = micConstraints(prefs, 'usb')
    expect(withMicDefaults({ audio: true }, defaults)).toEqual({ audio: defaults })
    expect(withMicDefaults({ audio: { deviceId: { exact: 'desk' } } }, defaults)).toEqual({
      audio: { ...defaults, deviceId: { exact: 'desk' } },
    })
    expect(withMicDefaults({ video: true }, defaults)).toEqual({ video: true })
    expect(withMicDefaults({ audio: false, video: true }, defaults)).toEqual({ audio: false, video: true })
  })
})

describe('output choice', () => {
  const list = deviceList(CHROME)

  it('hides the output picker where media elements cannot choose a sink', () => {
    expect(canSetSink({})).toBe(false)
    expect(canSetSink(undefined)).toBe(false)
    expect(canSetSink({ setSinkId: () => undefined })).toBe(true)
    expect(outputChoice(false, list)).toBe(false)
  })

  it('hides it too when the browser lists no outputs, as Firefox does', () => {
    expect(outputChoice(true, list)).toBe(true)
    expect(outputChoice(true, { ...list, speakers: [] })).toBe(false)
    expect(outputChoice(true, { ...list, listed: false })).toBe(false)
  })

  it('names the phones whose system picks the output', () => {
    const pixel = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
    expect(phoneOutput(pixel, 5)).toBe('android')
    expect(phoneOutput(iphone, 5)).toBe('ios')
    expect(phoneOutput(ipad, 5)).toBe('ios')
    expect(phoneOutput(ipad, 0)).toBeNull()
  })
})

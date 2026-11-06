import { describe, expect, it } from 'vitest'
import { type AudioDeps, AudioDeviceStore, lostMessage, micKey } from './audio-store'

type Info = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

const DESK: Info = { kind: 'audioinput', deviceId: 'desk', label: 'Desk Mic' }
const USB: Info = { kind: 'audioinput', deviceId: 'usb', label: 'USB Headset' }
const USB_OUT: Info = { kind: 'audiooutput', deviceId: 'usb-out', label: 'USB Headset' }
const SPEAKERS: Info = { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' }
const HIDDEN: Info = { kind: 'audioinput', deviceId: '', label: '' }

class FakeMedia extends EventTarget {
  devices: Info[] = [DESK, USB, SPEAKERS, USB_OUT]
  requests: MediaStreamConstraints[] = []
  refuse: Error | null = null

  enumerateDevices = async () => Promise.resolve(this.devices as MediaDeviceInfo[])

  getUserMedia = async (request?: MediaStreamConstraints) => {
    this.requests.push(request ?? {})
    if (this.refuse !== null) {
      throw this.refuse
    }
    this.devices = this.devices.map((info) => (info === HIDDEN ? DESK : info))
    return Promise.resolve({ getTracks: () => [{ stop: () => undefined }] } as unknown as MediaStream)
  }

  unplug(id: string): void {
    this.devices = this.devices.filter((info) => info.deviceId !== id)
    this.dispatchEvent(new Event('devicechange'))
  }
}

const settle = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

function setup({ stored = null, inUse = true }: { stored?: string | null; inUse?: boolean } = {}) {
  const media = new FakeMedia()
  const saved: string[] = []
  const lost: string[] = []
  const deps: AudioDeps = {
    media,
    storage: {
      read: () => stored,
      write: (value) => {
        saved.push(value)
      },
    },
    sinkSupported: true,
    inUse: () => inUse,
    onLost: (message) => {
      lost.push(message)
    },
    describeError: (e) => `denied: ${e instanceof Error ? e.message : String(e)}`,
  }
  const store = new AudioDeviceStore(deps)
  const stop = store.start()
  return { store, media, saved, lost, stop }
}

const headset = JSON.stringify({
  mic: { id: 'usb', label: 'USB Headset' },
  speaker: { id: 'usb-out', label: 'USB Headset' },
})

describe('AudioDeviceStore', () => {
  it('lists devices and resolves the saved ones', async () => {
    const { store } = setup({ stored: headset })
    await settle()
    const state = store.getSnapshot()
    expect(state.listed).toBe(true)
    expect(state.mics.map((mic) => mic.id)).toEqual(['desk', 'usb'])
    expect(state.mic).toEqual({ id: 'usb', missing: null })
    expect(state.speaker).toEqual({ id: 'usb-out', missing: null })
    expect(store.micConstraints()).toMatchObject({ deviceId: { exact: 'usb' }, echoCancellation: true })
  })

  it('saves a choice with its label, and the system default as nothing', async () => {
    const { store, saved } = setup()
    await settle()
    store.chooseMic('usb')
    store.setProcessing('autoGainControl', false)
    store.chooseSpeaker(null)
    expect(JSON.parse(saved.at(-1) ?? '{}')).toMatchObject({
      mic: { id: 'usb', label: 'USB Headset' },
      speaker: null,
      autoGainControl: false,
    })
    expect(micKey(store.getSnapshot())).toBe('usb|true|true|false')
  })

  it('falls back to the default when an in-use device is unplugged, with one toast', async () => {
    const { store, media, lost } = setup({ stored: headset })
    await settle()
    media.unplug('usb')
    media.unplug('usb-out')
    await settle()
    media.dispatchEvent(new Event('devicechange'))
    await settle()
    expect(store.getSnapshot().mic).toEqual({ id: null, missing: { id: 'usb', label: 'USB Headset' } })
    expect(store.getSnapshot().speaker.id).toBeNull()
    expect(lost).toEqual([lostMessage(['USB Headset'])])
    expect(store.micConstraints()).not.toHaveProperty('deviceId')
  })

  it('keeps the saved choice for when the device comes back', async () => {
    const { store, media } = setup({ stored: headset })
    await settle()
    media.unplug('usb')
    await settle()
    media.devices = [...media.devices, USB]
    media.dispatchEvent(new Event('devicechange'))
    await settle()
    expect(store.getSnapshot().mic).toEqual({ id: 'usb', missing: null })
  })

  it('notes a missing device quietly when no call uses it', async () => {
    const { store, media, lost } = setup({ stored: headset, inUse: false })
    await settle()
    media.unplug('usb')
    await settle()
    expect(store.getSnapshot().mic.missing?.label).toBe('USB Headset')
    expect(lost).toEqual([])
  })

  it('lists devices once the microphone is allowed, or says why it is not', async () => {
    const { store, media } = setup()
    media.devices = [HIDDEN]
    await store.refresh()
    expect(store.getSnapshot().listed).toBe(false)
    media.refuse = new Error('NotAllowedError')
    await store.allow()
    expect(store.getSnapshot().blocked).toBe('denied: NotAllowedError')
    media.refuse = null
    await store.allow()
    expect(store.getSnapshot()).toMatchObject({ listed: true, blocked: null })
    expect(media.requests.at(-1)).toMatchObject({ audio: { echoCancellation: true } })
  })

  it('stops following device changes when stopped', async () => {
    const { store, media, stop } = setup({ stored: headset })
    await settle()
    stop()
    media.unplug('usb')
    await settle()
    expect(store.getSnapshot().mic.id).toBe('usb')
  })
})

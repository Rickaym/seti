import type { Page } from '@playwright/test'

/** What the page did with audio devices, recorded before the app loads. */
export interface AudioSpy {
  /** Device ids of the microphone tracks handed to a peer connection sender. */
  sent: string[]
  /** The audio constraints of every microphone request. */
  requests: MediaTrackConstraints[]
  /** The sink of each test tone as it started. */
  tones: string[]
  /** How often a live stream, such as the EA's voice, started playing. */
  voices: number
}

type SpyWindow = Window & { audioSpy?: AudioSpy }

function installSpy(removeSink: boolean): void {
  const spy: AudioSpy = { sent: [], requests: [], tones: [], voices: 0 }
  ;(window as SpyWindow).audioSpy = spy
  const microphones = new WeakSet<MediaStreamTrack>()
  const lastSent = new WeakMap<RTCRtpSender, MediaStreamTrack>()
  const media = navigator.mediaDevices
  const getUserMedia = media.getUserMedia.bind(media)
  media.getUserMedia = async (request) => {
    if (typeof request?.audio === 'object') {
      spy.requests.push(request.audio)
    }
    const stream = await getUserMedia(request)
    for (const track of stream.getAudioTracks()) {
      microphones.add(track)
    }
    return stream
  }
  const replaceTrack = Reflect.get(RTCRtpSender.prototype, 'replaceTrack')
  RTCRtpSender.prototype.replaceTrack = async function (track) {
    if (track !== null && microphones.has(track) && lastSent.get(this) !== track) {
      lastSent.set(this, track)
      spy.sent.push(track.getSettings().deviceId ?? '')
    }
    return replaceTrack.call(this, track)
  }
  const canSetSink = typeof HTMLMediaElement.prototype.setSinkId === 'function' && !removeSink
  const play = Reflect.get(HTMLMediaElement.prototype, 'play')
  HTMLMediaElement.prototype.play = async function () {
    if (this.src.startsWith('blob:')) {
      spy.tones.push(canSetSink ? this.sinkId : 'none')
    }
    if (this.srcObject instanceof MediaStream) {
      spy.voices += 1
    }
    return play.call(this)
  }
  if (removeSink) {
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId')
  }
}

/** Records device use; `withoutSink` also makes the browser one that cannot choose an output. */
export async function spyOnAudio(page: Page, { withoutSink = false } = {}): Promise<void> {
  await page.addInitScript(installSpy, withoutSink)
}

export async function audioSpy(page: Page): Promise<AudioSpy> {
  return page.evaluate(() => (window as SpyWindow).audioSpy ?? { sent: [], requests: [], tones: [], voices: 0 })
}

export async function deviceId(page: Page, label: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.find((device) => device.label === wanted)?.deviceId ?? ''
  }, label)
}

/** Hides a device from the page and announces the change, as unplugging it would. */
export async function unplug(page: Page, id: string): Promise<void> {
  await page.evaluate((gone) => {
    const media = navigator.mediaDevices
    const enumerate = media.enumerateDevices.bind(media)
    media.enumerateDevices = async () => (await enumerate()).filter((device) => device.deviceId !== gone)
    media.dispatchEvent(new Event('devicechange'))
  }, id)
}

export async function announceDeviceChange(page: Page): Promise<void> {
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')))
}

/** Lists a Bluetooth headset, as Chrome on Android does once one connects, and announces it. */
export async function plugHeadset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const media = navigator.mediaDevices
    const enumerate = media.enumerateDevices.bind(media)
    const headset = (kind: MediaDeviceKind) =>
      ({
        deviceId: `bt-${kind}`,
        groupId: 'bt',
        kind,
        label: 'Bluetooth headset',
        toJSON: () => ({}),
      }) as MediaDeviceInfo
    media.enumerateDevices = async () => [...(await enumerate()), headset('audioinput'), headset('audiooutput')]
    media.dispatchEvent(new Event('devicechange'))
  })
}

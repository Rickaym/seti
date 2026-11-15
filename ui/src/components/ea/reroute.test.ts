import { describe, expect, it } from 'vitest'
import { inputKind } from './device-kind'
import { deviceSignature, handOver, QUIET_MS, Rerouter, SETTLE_MS, watchDevices } from './reroute'

const settle = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/** A clock and timer queue the test moves by hand. */
function fakeTime() {
  let now = 0
  let timers: { at: number; task: () => void }[] = []
  return {
    now: () => now,
    later: (task: () => void, ms: number) => {
      const timer = { at: now + ms, task }
      timers.push(timer)
      return () => {
        timers = timers.filter((t) => t !== timer)
      }
    },
    advance: (ms: number) => {
      now += ms
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const timer of due) {
        timer.task()
      }
    },
    pending: () => timers.length,
  }
}

function setup({ fail = false } = {}) {
  const time = fakeTime()
  let runs = 0
  let rerouted = 0
  let release: () => void = () => undefined
  let hold = false
  const rerouter = new Rerouter({
    run: async () => {
      runs += 1
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (fail) {
        throw new Error('no microphone')
      }
    },
    later: time.later,
    now: time.now,
    rerouted: () => {
      rerouted += 1
    },
  })
  return {
    rerouter,
    time,
    runs: () => runs,
    rerouted: () => rerouted,
    holdRuns: () => {
      hold = true
    },
    release: () => {
      release()
    },
  }
}

describe('Rerouter', () => {
  it('takes the first device list as the baseline and ignores an unchanged one', async () => {
    const { rerouter, time, runs } = setup()
    rerouter.devicesChanged('a')
    rerouter.devicesChanged('a')
    time.advance(SETTLE_MS)
    await settle()
    expect(runs()).toBe(0)
    expect(time.pending()).toBe(0)
  })

  it('waits for the device list to settle and reroutes once for a burst of changes', async () => {
    const { rerouter, time, runs, rerouted } = setup()
    rerouter.devicesChanged('a')
    rerouter.devicesChanged('a,bt')
    time.advance(SETTLE_MS - 1)
    rerouter.devicesChanged('a,bt,bt-out')
    time.advance(SETTLE_MS - 1)
    expect(runs()).toBe(0)
    time.advance(1)
    await settle()
    expect(runs()).toBe(1)
    expect(rerouted()).toBe(1)
  })

  it('never loops: changes during a reroute and right after it are taken as its echo', async () => {
    const { rerouter, time, runs, holdRuns, release } = setup()
    holdRuns()
    rerouter.devicesChanged('a')
    rerouter.devicesChanged('a,bt')
    time.advance(SETTLE_MS)
    expect(runs()).toBe(1)
    rerouter.devicesChanged('a,bt,sco')
    release()
    await settle()
    rerouter.devicesChanged('a,bt')
    time.advance(QUIET_MS - 1)
    await settle()
    expect(runs()).toBe(1)
    expect(time.pending()).toBe(0)
    time.advance(1)
    rerouter.devicesChanged('a')
    time.advance(SETTLE_MS)
    await settle()
    expect(runs()).toBe(2)
  })

  it('reroutes at once on demand, drops a pending one and joins a press made while it runs', async () => {
    const { rerouter, time, runs, holdRuns, release, rerouted } = setup()
    rerouter.devicesChanged('a')
    rerouter.devicesChanged('a,bt')
    holdRuns()
    const first = rerouter.reroute()
    const second = rerouter.reroute()
    expect(time.pending()).toBe(0)
    release()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(runs()).toBe(1)
    expect(rerouted()).toBe(1)
  })

  it('reports a failed reroute without counting it', async () => {
    const { rerouter, rerouted } = setup({ fail: true })
    expect(await rerouter.reroute()).toBe(false)
    expect(rerouted()).toBe(0)
  })

  it('drops a pending reroute when the user switches the microphone, and does nothing once stopped', async () => {
    const { rerouter, time, runs } = setup()
    rerouter.devicesChanged('a')
    rerouter.devicesChanged('a,bt')
    rerouter.switched()
    expect(time.pending()).toBe(0)
    time.advance(QUIET_MS)
    rerouter.stop()
    rerouter.devicesChanged('a')
    expect(await rerouter.reroute()).toBe(false)
    expect(runs()).toBe(0)
  })
})

function track(readyState: MediaStreamTrackState = 'live') {
  return { readyState } as MediaStreamTrack
}

describe('handOver', () => {
  it('reopens the microphone, hands its new track to the sender and replays the voice', async () => {
    const steps: string[] = []
    const opened = track()
    const replaced: (MediaStreamTrack | null)[] = []
    await handOver({
      reopen: async () => {
        steps.push('reopen')
        await Promise.resolve()
      },
      micOn: () => true,
      track: () => opened,
      sender: () => ({
        replaceTrack: async (next) => {
          steps.push('replace')
          replaced.push(next)
          await Promise.resolve()
        },
      }),
      reattach: () => steps.push('reattach'),
    })
    expect(steps).toEqual(['reopen', 'replace', 'reattach'])
    expect(replaced).toEqual([opened])
  })

  it('leaves a muted call silent, and fails when the microphone did not reopen', async () => {
    const replaced: unknown[] = []
    const base = {
      reopen: async () => Promise.resolve(),
      sender: () => ({
        replaceTrack: async (next: MediaStreamTrack | null) => {
          replaced.push(next)
          await Promise.resolve()
        },
      }),
      reattach: () => undefined,
    }
    await handOver({ ...base, micOn: () => false, track: () => track() })
    expect(replaced).toEqual([])
    await expect(handOver({ ...base, micOn: () => true, track: () => null })).rejects.toThrow()
    await expect(handOver({ ...base, micOn: () => true, track: () => track('ended') })).rejects.toThrow()
  })
})

describe('watchDevices', () => {
  it('signs the audio devices only, and reports the latest list after each change', async () => {
    const media = new EventTarget() as EventTarget & Pick<MediaDevices, 'enumerateDevices'>
    let devices = [
      { kind: 'audioinput', deviceId: 'b' },
      { kind: 'videoinput', deviceId: 'cam' },
      { kind: 'audiooutput', deviceId: 'a' },
    ]
    media.enumerateDevices = async () => Promise.resolve(devices as MediaDeviceInfo[])
    const seen: string[] = []
    const stop = watchDevices(media, (signature) => seen.push(signature))
    await settle()
    devices = [...devices, { kind: 'audioinput', deviceId: 'bt' }]
    media.dispatchEvent(new Event('devicechange'))
    await settle()
    stop()
    media.dispatchEvent(new Event('devicechange'))
    await settle()
    expect(seen).toEqual(['audioinput:b,audiooutput:a', 'audioinput:b,audioinput:bt,audiooutput:a'])
    expect(deviceSignature([])).toBe('')
  })
})

describe('inputKind', () => {
  it('names the kind of microphone without its name', () => {
    expect(inputKind('Bluetooth headset', false)).toBe('bluetooth')
    expect(inputKind('Headset earpiece', true)).toBe('built-in')
    expect(inputKind('Speakerphone', true)).toBe('built-in')
    expect(inputKind('USB audio', true)).toBe('usb')
    expect(inputKind('Wired headset', true)).toBe('wired')
    expect(inputKind('Default', false)).toBe('default')
    expect(inputKind('Studio Mic 3', true)).toBe('other')
  })
})

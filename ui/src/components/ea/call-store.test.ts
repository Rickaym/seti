import type { EaRequestData } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { EaCallStore, type CallDeps, type CallHandlers, type LiveCall } from './call-store'

interface FakeCall {
  handlers: CallHandlers
  requestData: EaRequestData | null
  stopped: boolean
  mic: boolean[]
  switched: (string | null)[]
  mics: MediaTrackConstraints[]
  sent: string[]
  answer: () => void
  refuse: (error: Error) => void
}

function setup(overrides: Partial<CallDeps> = {}) {
  const calls: FakeCall[] = []
  const createCall = (_ice: RTCIceServer[], handlers: CallHandlers, mic: () => MediaTrackConstraints): LiveCall => {
    let answer: () => void = () => undefined
    let refuse: (error: Error) => void = () => undefined
    const answered = new Promise<void>((resolve, reject) => {
      answer = resolve
      refuse = reject
    })
    const call: FakeCall = {
      handlers,
      requestData: null,
      stopped: false,
      mic: [],
      switched: [],
      mics: [mic()],
      sent: [],
      answer,
      refuse,
    }
    calls.push(call)
    return {
      connect: async (requestData) => {
        call.requestData = requestData
        await answered
      },
      stop: async () => {
        call.stopped = true
        await Promise.resolve()
      },
      enableMic: (on) => {
        call.mic.push(on)
      },
      switchMic: (deviceId) => {
        call.switched.push(deviceId)
      },
      send: (type) => {
        call.sent.push(type)
      },
      failure: async (e) => Promise.resolve(`failed: ${e instanceof Error ? e.message : String(e)}`),
    }
  }
  const deps: CallDeps = {
    loadEngine: async () => Promise.resolve({ createCall }),
    preflight: () => null,
    iceServers: async () => Promise.resolve([]),
    probeMicrophone: async () => Promise.resolve(null),
    requestData: () => ({ timezone: 'Asia/Singapore', localTime: '2026-09-27T22:30:00+08:00' }),
    now: () => 1,
    mic: () => ({ echoCancellation: false }),
    ...overrides,
  }
  const store = new EaCallStore(deps)
  let notified = 0
  store.subscribe(() => {
    notified += 1
  })
  return { store, calls, notified: () => notified }
}

const settle = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

describe('EaCallStore', () => {
  it('connects one call and sends the browser clock with the offer', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    expect(store.getSnapshot().phase).toBe('connecting')
    await settle()
    calls[0]?.answer()
    await connecting
    expect(calls).toHaveLength(1)
    expect(calls[0]?.requestData).toEqual({ timezone: 'Asia/Singapore', localTime: '2026-09-27T22:30:00+08:00' })
    expect(store.getSnapshot().phase).toBe('connected')
  })

  it('marks a call Seti joins on its own, in its offer and its failure', async () => {
    const { store, calls } = setup()
    const connecting = store.connect({ auto: true })
    expect(store.getSnapshot().auto).toBe(true)
    await settle()
    calls[0]?.refuse(new Error('busy'))
    await connecting
    expect(calls[0]?.requestData).toMatchObject({ timezone: 'Asia/Singapore', auto: true })
    expect(store.getSnapshot().failure).toMatchObject({ dropped: false, auto: true })
    const again = store.connect()
    expect(store.getSnapshot().auto).toBe(false)
    await settle()
    calls[1]?.answer()
    await again
    expect(calls[1]?.requestData).not.toHaveProperty('auto')
  })

  it('records when the browser blocks the EA voice and replays it on the next gesture', () => {
    const { store } = setup()
    let unlocked = 0
    store.setAudioUnlock(() => {
      unlocked += 1
    })
    store.setAudioBlocked(true)
    expect(store.getSnapshot().audioBlocked).toBe(true)
    store.resumeAudio()
    expect(unlocked).toBe(1)
    store.setAudioBlocked(false)
    expect(store.getSnapshot().audioBlocked).toBe(false)
  })

  it('opens the chosen microphone and switches it only while connected', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    await settle()
    store.switchMic('usb')
    calls[0]?.answer()
    await connecting
    store.switchMic('usb')
    store.switchMic(null)
    expect(calls[0]?.mics).toEqual([{ echoCancellation: false }])
    expect(calls[0]?.switched).toEqual(['usb', null])
  })

  it('hangs up a live call and releases it', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    await settle()
    calls[0]?.answer()
    await connecting
    await store.hangUp()
    expect(calls[0]?.stopped).toBe(true)
    expect(store.getSnapshot().phase).toBe('idle')
  })

  it('a hang-up while connecting wins over the answer that arrives later', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    await settle()
    await store.hangUp()
    calls[0]?.answer()
    await connecting
    expect(calls[0]?.stopped).toBe(true)
    expect(store.getSnapshot().phase).toBe('idle')
  })

  it('ignores events from a call that a newer connect replaced', async () => {
    const { store, calls } = setup()
    const first = store.connect()
    await settle()
    const second = store.connect()
    await settle()
    expect(calls[0]?.stopped).toBe(true)
    calls[0]?.handlers.dispatch({ type: 'bot-speaking', speaking: true, at: 2 })
    calls[0]?.handlers.dropped('stale')
    calls[1]?.answer()
    calls[0]?.answer()
    await Promise.all([first, second])
    expect(store.getSnapshot()).toMatchObject({ phase: 'connected', error: null })
    expect(store.getSnapshot().signals.botSpeaking).toBe(false)
  })

  it('reports a refused offer and a dropped call', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    await settle()
    calls[0]?.refuse(new Error('offer refused'))
    await connecting
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'failed: offer refused' })
    expect(store.getSnapshot().failure).toEqual({ at: 1, dropped: false, auto: false })

    const again = store.connect()
    await settle()
    calls[1]?.answer()
    await again
    calls[1]?.handlers.dropped('The EA hit an error.')
    expect(store.getSnapshot()).toMatchObject({ phase: 'error', error: 'The EA hit an error.' })
    expect(store.getSnapshot().failure).toEqual({ at: 1, dropped: true, auto: false })
  })

  it('stops before creating a call when the page or the microphone cannot capture audio', async () => {
    const blocked = setup({ preflight: () => 'Microphone access needs a secure context.' })
    await blocked.store.connect()
    expect(blocked.calls).toHaveLength(0)
    expect(blocked.store.getSnapshot().error).toBe('Microphone access needs a secure context.')

    const noMic = setup({ probeMicrophone: async () => Promise.resolve('No microphone found.') })
    await noMic.store.connect()
    expect(noMic.calls).toHaveLength(0)
    expect(noMic.store.getSnapshot()).toMatchObject({ phase: 'error', error: 'No microphone found.' })
  })

  it('asks for the microphone and unlocks audio before its first await', () => {
    const steps: string[] = []
    const { store } = setup({
      probeMicrophone: async () => {
        steps.push('mic')
        return Promise.resolve(null)
      },
    })
    store.setAudioUnlock(() => {
      steps.push('audio')
    })
    void store.connect()
    expect(steps).toEqual(['audio', 'mic'])
  })

  it('mutes the microphone of the live call', async () => {
    const { store, calls, notified } = setup()
    const connecting = store.connect()
    await settle()
    calls[0]?.answer()
    await connecting
    const before = notified()
    store.setMic(false)
    expect(calls[0]?.mic).toEqual([false])
    expect(store.getSnapshot().micOn).toBe(false)
    expect(notified()).toBe(before + 1)
  })

  it('passes changes made in Seti to a connected call only', async () => {
    const { store, calls } = setup()
    store.notify('ea-settings-changed')
    const connecting = store.connect()
    await settle()
    store.notify('ea-settings-changed')
    calls[0]?.answer()
    await connecting
    store.notify('ea-history-cleared')
    expect(calls[0]?.sent).toEqual(['ea-history-cleared'])
  })

  it('drops the captions of the live call when a new conversation starts', async () => {
    const { store, calls } = setup()
    const connecting = store.connect()
    await settle()
    calls[0]?.answer()
    await connecting
    calls[0]?.handlers.dispatch({ type: 'caption', event: { type: 'user', text: 'Hello', final: true, at: 2 } })
    expect(store.getSnapshot().captions.items).toHaveLength(2)
    store.clearCaptions()
    expect(store.getSnapshot().captions.items).toEqual([])
  })
})

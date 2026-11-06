import { describe, expect, it } from 'vitest'
import { asleep, callReducer, initialCallState, latestLine, type CallAction, type CallState } from './call-state'
import { barStatus, idleLook, isCallShortcut, statusOf } from './call-status'

const run = (actions: CallAction[], from: CallState = initialCallState) => actions.reduce(callReducer, from)

const connected = run([
  { type: 'connecting', auto: false },
  { type: 'connected', at: 1 },
])

describe('callReducer', () => {
  it('marks where a call started and ended', () => {
    const state = run([{ type: 'ended', at: 9, error: null }], connected)
    expect(state.phase).toBe('idle')
    expect(state.captions.items.map((item) => (item.kind === 'marker' ? item.text : item.kind))).toEqual([
      'Call started',
      'Call ended',
    ])
  })

  it('does not mark a call that never connected, and keeps the error', () => {
    const state = run([
      { type: 'connecting', auto: false },
      { type: 'ended', at: 2, error: 'No microphone found.' },
    ])
    expect(state.phase).toBe('error')
    expect(state.error).toBe('No microphone found.')
    expect(state.captions.items).toEqual([])
  })

  it('records each failure and whether a live call dropped', () => {
    const refused = run([
      { type: 'connecting', auto: false },
      { type: 'ended', at: 2, error: 'No microphone found.' },
    ])
    expect(refused.failure).toEqual({ at: 2, dropped: false, auto: false })
    const again = run([{ type: 'ended', at: 2, error: 'No microphone found.' }], refused)
    expect(again.failure).toEqual(refused.failure)
    expect(again.failure).not.toBe(refused.failure)
    expect(run([{ type: 'ended', at: 5, error: 'The EA hit an error.' }], connected).failure).toEqual({
      at: 5,
      dropped: true,
      auto: false,
    })
    const joined = run([
      { type: 'connecting', auto: true },
      { type: 'ended', at: 7, error: 'Busy' },
    ])
    expect(joined.failure).toEqual({ at: 7, dropped: false, auto: true })
    expect(run([{ type: 'connecting', auto: false }], refused).failure).toBeNull()
    expect(run([{ type: 'ended', at: 9, error: null }], connected).failure).toBeNull()
  })

  it('ignores a hang-up when nothing is connected', () => {
    expect(run([{ type: 'ended', at: 1, error: null }])).toBe(initialCallState)
  })

  it('times the reply from the user going quiet to the EA speaking', () => {
    const state = run(
      [
        { type: 'user-speaking', speaking: true, at: 10 },
        { type: 'user-speaking', speaking: false, at: 100 },
        { type: 'bot-speaking', speaking: true, at: 400 },
        { type: 'bot-speaking', speaking: false, at: 900 },
        { type: 'user-speaking', speaking: false, at: 1000 },
        { type: 'bot-speaking', speaking: true, at: 1500 },
      ],
      connected,
    )
    expect(state.signals.latency).toEqual({ last: 500, average: 400 })
    expect(state.signals.botSpeaking).toBe(true)
  })

  it('clears who is speaking and the tracks when the call ends', () => {
    const state = run(
      [
        { type: 'bot-speaking', speaking: true, at: 2 },
        { type: 'mic-held', held: true },
        { type: 'ended', at: 3, error: 'The EA hit an error.' },
      ],
      connected,
    )
    expect(state.signals).toMatchObject({ botSpeaking: false, userSpeaking: false, micHeld: false })
    expect(state.tracks).toEqual({ local: null, bot: null })
  })

  it('unmutes the microphone and resets the latency for a new call', () => {
    const muted = run(
      [
        { type: 'mic', on: false },
        { type: 'user-speaking', speaking: false, at: 1 },
        { type: 'bot-speaking', speaking: true, at: 5 },
      ],
      connected,
    )
    const next = run([{ type: 'connecting', auto: false }], muted)
    expect(next.micOn).toBe(true)
    expect(next.signals.latency).toBeNull()
    expect(next.captions.items).toEqual([])
  })

  it('follows the wake word state and forgets it when the call ends', () => {
    const wake = { enabled: true, awake: false, phrase: 'Hey Seti' }
    const sleeping = run([{ type: 'wake', wake }], connected)
    expect(asleep(sleeping)).toBe(true)
    expect(statusOf(sleeping)).toEqual({ light: 'off', label: 'Asleep' })
    expect(barStatus(sleeping)).toBe('Say "Hey Seti"')
    expect(barStatus(run([{ type: 'bot-speaking', speaking: true, at: 2 }], sleeping))).toBe('EA speaking')

    const awake = run([{ type: 'wake', wake: { ...wake, awake: true } }], sleeping)
    expect(asleep(awake)).toBe(false)
    expect(barStatus(awake)).toBe('Listening')
    expect(asleep(run([{ type: 'wake', wake: { ...wake, enabled: false } }], sleeping))).toBe(false)
    expect(run([{ type: 'ended', at: 5, error: null }], sleeping).wake).toBeNull()
  })
})

describe('latestLine', () => {
  it('is the newest speech, skipping actions and markers', () => {
    const state = run(
      [
        { type: 'caption', event: { type: 'user', text: 'What is running?', final: true, at: 2 } },
        { type: 'caption', event: { type: 'bot-segment', segment: 1, spoken: 'Two tasks.', at: 3 } },
        { type: 'caption', event: { type: 'call-started', tool: 'list_tasks', callId: 'c1', at: 4 } },
      ],
      connected,
    )
    expect(latestLine(state.captions)).toMatchObject({ kind: 'bot', text: 'Two tasks.' })
    expect(latestLine(initialCallState.captions)).toBeNull()
  })
})

describe('barStatus', () => {
  it('says who is talking, or that the mic is muted', () => {
    expect(barStatus(run([{ type: 'connecting', auto: false }]))).toBe('Connecting')
    expect(barStatus(connected)).toBe('Listening')
    expect(barStatus(run([{ type: 'user-speaking', speaking: true, at: 2 }], connected))).toBe('Hearing you')
    expect(barStatus(run([{ type: 'mic', on: false }], connected))).toBe('Mic muted')
    expect(barStatus(run([{ type: 'bot-speaking', speaking: true, at: 2 }], connected))).toBe('EA speaking')
  })
})

describe('idleLook', () => {
  it('warns about setup before it shows the last failure', () => {
    expect(idleLook('idle', false)).toBe('ready')
    expect(idleLook('error', false)).toBe('failed')
    expect(idleLook('error', true)).toBe('setup')
    expect(idleLook('idle', true)).toBe('setup')
    expect(idleLook('error', false, true)).toBe('ready')
  })
})

describe('isCallShortcut', () => {
  const chord = { code: 'KeyE', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }

  it('takes Ctrl+Shift+E only', () => {
    expect(isCallShortcut(chord)).toBe(true)
    expect(isCallShortcut({ ...chord, shiftKey: false })).toBe(false)
    expect(isCallShortcut({ ...chord, altKey: true })).toBe(false)
    expect(isCallShortcut({ ...chord, code: 'KeyR' })).toBe(false)
  })
})

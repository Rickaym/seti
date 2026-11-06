import type { AgentNotifyKind } from '@seti/shared'

const SOUND_KEY = 'seti.notify.sound'

interface Tone {
  hz: number
  at: number
  length: number
}

/** A rising pair for a finished turn; a quicker, sharper three for an agent that needs you. */
const TUNES: Record<AgentNotifyKind, { wave: OscillatorType; tones: readonly Tone[] }> = {
  finished: {
    wave: 'sine',
    tones: [
      { hz: 659.25, at: 0, length: 0.14 },
      { hz: 987.77, at: 0.13, length: 0.22 },
    ],
  },
  needs_you: {
    wave: 'triangle',
    tones: [
      { hz: 880, at: 0, length: 0.09 },
      { hz: 698.46, at: 0.11, length: 0.09 },
      { hz: 880, at: 0.22, length: 0.14 },
    ],
  },
}

const VOLUME = 0.12

export function soundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}

let context: AudioContext | null = null

/** Plays the kind's short tune; browsers stay silent until the page has had a click or a key. */
export function playSound(kind: AgentNotifyKind): void {
  if (typeof AudioContext === 'undefined') {
    return
  }
  context ??= new AudioContext()
  const audio = context
  void audio.resume().catch(() => undefined)
  const { wave, tones } = TUNES[kind]
  const start = audio.currentTime + 0.02
  for (const tone of tones) {
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = wave
    oscillator.frequency.value = tone.hz
    gain.gain.setValueAtTime(0, start + tone.at)
    gain.gain.linearRampToValueAtTime(VOLUME, start + tone.at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.length)
    oscillator.connect(gain).connect(audio.destination)
    oscillator.start(start + tone.at)
    oscillator.stop(start + tone.at + tone.length + 0.02)
  }
}

import { isIosAgent } from '@/lib/ios'

/** The microphone's state: live, muted by the system, ended, or not opened. */
export type MicHealth = 'live' | 'muted' | 'ended' | 'none'

/** What the call's microphone gives the EA right now. */
export interface Hearing {
  mic: MicHealth
  /** The microphone's total audio energy so far; null when the browser reports none. */
  energy: number | null
}

/** The line a call shows on devices that silence the microphone of an app in the background. */
export const BACKGROUND_LINE = 'The EA cannot hear you while Seti is in the background on this device'

/** Phones silence a backgrounded browser's microphone: Android without a call service, iOS always. */
export const backgroundSilences = (ua: string, maxTouchPoints: number): boolean =>
  ua.includes('Android') || isIosAgent(ua, maxTouchPoints)

/** Less energy than this over a whole absence means the EA heard nothing at all. */
const SILENT_ENERGY = 1e-7

/** Shorter absences go unremarked. */
const MIN_AWAY_MS = 5_000

export const micHealth = (track: MediaStreamTrack | null): MicHealth => {
  if (track === null) {
    return 'none'
  }
  if (track.readyState === 'ended') {
    return 'ended'
  }
  return track.muted ? 'muted' : 'live'
}

/** The sent microphone's total energy, from the peer connection's media-source stats. */
export function sourceEnergy(report: RTCStatsReport): number | null {
  for (const stat of report.values() as IterableIterator<Record<string, unknown>>) {
    if (stat.type === 'media-source' && stat.kind === 'audio' && typeof stat.totalAudioEnergy === 'number') {
      return stat.totalAudioEnergy
    }
  }
  return null
}

/** "You were away for 2 min; the EA could not hear you". */
export function awayText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const span = seconds < 60 ? `${String(seconds)} s` : `${String(Math.round(seconds / 60))} min`
  return `You were away for ${span}; the EA could not hear you`
}

export interface AwayDeps {
  /** What the live call hears; null when there is no call. */
  hearing: () => Promise<Hearing | null>
  micOn: () => boolean
  /** Opens the microphone again and sends its new track; the reroute path. */
  reopen: () => Promise<unknown>
  note: (text: string) => void
  now: () => number
}

interface Left {
  at: number
  micOn: boolean
  energy: number | null
}

function deaf(left: Left, heard: Hearing): boolean {
  if (heard.mic !== 'live') {
    return true
  }
  return left.energy !== null && heard.energy !== null && heard.energy - left.energy < SILENT_ENERGY
}

/** Notes what the microphone had when the page went to the background, and checks it on return. */
export class AwayWatch {
  private readonly deps: AwayDeps
  private left: Left | null = null

  constructor(deps: AwayDeps) {
    this.deps = deps
  }

  readonly hidden = async (): Promise<void> => {
    const left: Left = { at: this.deps.now(), micOn: this.deps.micOn(), energy: null }
    this.left = left
    const heard = await this.deps.hearing()
    if (this.left === left) {
      this.left = { ...left, energy: heard?.energy ?? null }
    }
  }

  /** Reopens a microphone the system dropped, and says so when the EA heard nothing meanwhile. */
  readonly shown = async (): Promise<void> => {
    const left = this.left
    this.left = null
    if (left === null) {
      return
    }
    const heard = await this.deps.hearing()
    if (heard === null) {
      return
    }
    if (heard.mic === 'ended' || heard.mic === 'muted') {
      await this.deps.reopen()
    }
    const away = this.deps.now() - left.at
    if (left.micOn && this.deps.micOn() && away >= MIN_AWAY_MS && deaf(left, heard)) {
      this.deps.note(awayText(away))
    }
  }

  readonly reset = (): void => {
    this.left = null
  }
}

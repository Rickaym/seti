import type { EaRequestData } from '@seti/shared'
import { callReducer, initialCallState, type CallAction, type CallState } from './call-state'

/** One peer connection to the bot, from the lazily loaded engine. */
export interface LiveCall {
  connect: (requestData: EaRequestData) => Promise<void>
  /** Ends the call and releases the microphone; never throws. */
  stop: () => Promise<void>
  enableMic: (on: boolean) => void
  /** Reopens the microphone on another device, null for the system default, mid-call. */
  switchMic: (deviceId: string | null) => void
  /** Sends an RTVI client message to the bot. */
  send: (type: string) => void
  /** The readable reason a connect failed. */
  failure: (error: unknown) => Promise<string>
}

export interface CallHandlers {
  dispatch: (action: CallAction) => void
  /** The call ended without a hang-up; `reason` says why when the engine knows. */
  dropped: (reason: string | null) => void
}

interface CallEngine {
  createCall: (iceServers: RTCIceServer[], handlers: CallHandlers, mic: () => MediaTrackConstraints) => LiveCall
}

export interface CallDeps {
  loadEngine: () => Promise<CallEngine>
  /** Why this page cannot capture audio at all, or null. */
  preflight: () => string | null
  iceServers: () => Promise<RTCIceServer[]>
  probeMicrophone: () => Promise<string | null>
  /** The chosen microphone and its processing, read whenever the call opens it. */
  mic: () => MediaTrackConstraints
  requestData: () => EaRequestData
  now: () => number
}

const errorText = (e: unknown) => (e instanceof Error && e.message.trim() !== '' ? e.message : 'Could not connect.')

/** The one voice call of the app; a newer connect or a hang-up supersedes a connect in flight. */
export class EaCallStore {
  private state: CallState = initialCallState
  private readonly listeners = new Set<() => void>()
  private readonly deps: CallDeps
  private generation = 0
  private live: LiveCall | null = null
  private unlockAudio: (() => void) | null = null

  constructor(deps: CallDeps) {
    this.deps = deps
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): CallState => this.state

  private dispatch(action: CallAction): void {
    const next = callReducer(this.state, action)
    if (next === this.state) {
      return
    }
    this.state = next
    for (const listener of this.listeners) {
      listener()
    }
  }

  private end(error: string | null): void {
    this.dispatch({ type: 'ended', at: this.deps.now(), error })
  }

  private async release(): Promise<void> {
    const live = this.live
    this.live = null
    await live?.stop()
  }

  /** Asks for the mic and unlocks audio before its first await; an `auto` call joins asleep. */
  readonly connect = async ({ auto = false }: { auto?: boolean } = {}): Promise<void> => {
    this.generation += 1
    const current = this.generation
    const superseded = () => this.generation !== current
    const blocked = this.deps.preflight()
    if (blocked !== null) {
      this.end(blocked)
      return
    }
    this.unlockAudio?.()
    const microphone = this.deps.probeMicrophone()
    this.dispatch({ type: 'connecting', auto })
    await this.release()
    let live: LiveCall | null = null
    try {
      const [engine, iceServers] = await Promise.all([this.deps.loadEngine(), this.deps.iceServers()])
      const micProblem = await microphone
      if (superseded()) {
        return
      }
      if (micProblem !== null) {
        this.end(micProblem)
        return
      }
      live = engine.createCall(
        iceServers,
        {
          dispatch: (action) => {
            if (!superseded()) {
              this.dispatch(action)
            }
          },
          dropped: (reason) => {
            if (!superseded()) {
              this.live = null
              this.end(reason)
            }
          },
        },
        this.deps.mic,
      )
      this.live = live
      await live.connect(auto ? { ...this.deps.requestData(), auto } : this.deps.requestData())
      if (!superseded()) {
        this.dispatch({ type: 'connected', at: this.deps.now() })
      }
    } catch (e) {
      if (superseded()) {
        return
      }
      const message = live === null ? errorText(e) : await live.failure(e)
      await this.release()
      if (!superseded()) {
        this.end(message)
      }
    }
  }

  /** Lets the bot's audio play later; iOS Safari allows that only when a tap started it. */
  readonly setAudioUnlock = (unlock: (() => void) | null): void => {
    this.unlockAudio = unlock
  }

  /** Records whether the browser refused to play the EA's voice without a user gesture. */
  readonly setAudioBlocked = (blocked: boolean): void => {
    this.dispatch({ type: 'audio-blocked', blocked })
  }

  /** Plays the EA's voice again from inside a user gesture, after the browser blocked it. */
  readonly resumeAudio = (): void => {
    this.unlockAudio?.()
  }

  readonly hangUp = async (): Promise<void> => {
    this.generation += 1
    this.end(null)
    await this.release()
  }

  readonly setMic = (on: boolean): void => {
    this.live?.enableMic(on)
    this.dispatch({ type: 'mic', on })
  }

  /** Moves a live call to the chosen microphone or processing without reconnecting. */
  readonly switchMic = (deviceId: string | null): void => {
    if (this.state.phase === 'connected') {
      this.live?.switchMic(deviceId)
    }
  }

  readonly setOutputMuted = (muted: boolean): void => {
    this.dispatch({ type: 'output-muted', muted })
  }

  /** Tells a live call that something it loaded from Seti changed; no-op between calls. */
  readonly notify = (type: string): void => {
    if (this.state.phase === 'connected') {
      this.live?.send(type)
    }
  }

  /** Drops this call's captions after the user started a new conversation. */
  readonly clearCaptions = (): void => {
    this.dispatch({ type: 'captions-cleared' })
  }
}

import { asleep, type CallPhase, type CallState } from './call-state'

type Light = 'off' | 'busy' | 'on' | 'bad'

export const LIGHT: Record<Light, string> = {
  off: 'bg-muted-foreground/40',
  busy: 'bg-warning-fill motion-safe:animate-pulse',
  on: 'bg-success',
  bad: 'bg-destructive',
}

const ASLEEP = 'Asleep'

export function statusOf(call: CallState): { light: Light; label: string } {
  switch (call.phase) {
    case 'idle':
      return { light: 'off', label: 'Not connected' }
    case 'connecting':
      return { light: 'busy', label: 'Connecting' }
    case 'error':
      return { light: 'bad', label: 'Call failed' }
    case 'connected':
      if (call.signals.botSpeaking) {
        return { light: 'on', label: 'EA speaking' }
      }
      if (!call.micOn) {
        return { light: 'on', label: 'Mic muted' }
      }
      if (asleep(call)) {
        return { light: 'off', label: ASLEEP }
      }
      return { light: 'on', label: call.signals.userSpeaking ? 'Hearing you' : 'Listening' }
  }
}

/** The short state the status bar shows during a call, with the wake phrase while asleep. */
export function barStatus(call: CallState): string {
  const { label } = statusOf(call)
  return label === ASLEEP && call.wake !== null ? `Say "${call.wake.phrase}"` : label
}

/** While asleep with its phrase heard on the EA's host, nothing goes to paid speech to text. */
export const LOCAL_HINT = 'Listening locally: no speech to text until the phrase'

export const listeningLocally = (call: CallState) => asleep(call) && call.wake?.local === true

/** The voice the level meters follow: the EA while it speaks, else the user's open mic. */
export function meterTrack({ signals, micOn, tracks }: CallState): MediaStreamTrack | null {
  if (signals.botSpeaking) {
    return tracks.bot
  }
  return micOn ? tracks.local : null
}

/** How the EA item looks between calls; a setup problem outranks the last failure. */
export type IdleLook = 'ready' | 'setup' | 'failed'

/** A call Seti joined on its own retries by itself, so its failure does not turn the item red. */
export function idleLook(phase: CallPhase, needsSetup: boolean, auto = false): IdleLook {
  if (needsSetup) {
    return 'setup'
  }
  return phase === 'error' && !auto ? 'failed' : 'ready'
}

interface KeyChord {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Ctrl+Shift+E: Ctrl and Shift keep it clear of the Alt chords and the composer. */
export const CALL_SHORTCUT = { label: 'Ctrl+Shift+E', aria: 'Control+Shift+E' } as const

export const isCallShortcut = (e: KeyChord) => e.code === 'KeyE' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey

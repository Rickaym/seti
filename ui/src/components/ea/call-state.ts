import { EA_MAX_INPUTS, type EaCallEndReason, type EaInputKind, type EaWake } from '@seti/shared'
import { captionsReducer, initialCaptions, type CaptionEvent, type CaptionState, type SpeechItem } from './captions'

export type CallPhase = 'idle' | 'connecting' | 'connected' | 'error'

export interface Latency {
  last: number
  average: number
}

interface CallSignals {
  userSpeaking: boolean
  botSpeaking: boolean
  /** The bot holds the microphone while it speaks. */
  micHeld: boolean
  latency: Latency | null
}

interface CallTracks {
  local: MediaStreamTrack | null
  bot: MediaStreamTrack | null
}

/** When the last attempt failed, whether as a live call, and whether Seti started it on its own. */
interface CallFailure {
  at: number
  dropped: boolean
  auto: boolean
}

/** How the last connected call ended, and whether Seti was in the background then. */
export interface CallEnd {
  reason: EaCallEndReason
  at: number
  hidden: boolean
}

/** The kinds of microphone a call used, in order, and how often it rerouted; for its audit record. */
export interface CallRoute {
  inputs: EaInputKind[]
  reroutes: number
}

type RouteEvent = { kind: 'input'; input: EaInputKind } | { kind: 'rerouted' }

export interface CallState {
  phase: CallPhase
  error: string | null
  failure: CallFailure | null
  captions: CaptionState
  signals: CallSignals
  micOn: boolean
  outputMuted: boolean
  tracks: CallTracks
  /** The bot's wake word state; null until it reports one. */
  wake: EaWake | null
  /** Seti joined this call on its own when it opened, rather than the user calling. */
  auto: boolean
  /** The browser refused to play the EA's voice until the user interacts with the page. */
  audioBlocked: boolean
  /** When the user last stopped speaking, to time how fast the EA answers. */
  userStoppedAt: number | null
  replies: { count: number; totalMs: number }
  lastEnd: CallEnd | null
  route: CallRoute
}

export type CallAction =
  | { type: 'connecting'; auto: boolean }
  | { type: 'connected'; at: number }
  | { type: 'ended'; at: number; error: string | null; reason: EaCallEndReason; hidden: boolean }
  | { type: 'caption'; event: CaptionEvent }
  | { type: 'user-speaking'; speaking: boolean; at: number }
  | { type: 'bot-speaking'; speaking: boolean; at: number }
  | { type: 'mic-held'; held: boolean }
  | { type: 'tracks'; tracks: CallTracks }
  | { type: 'mic'; on: boolean }
  | { type: 'output-muted'; muted: boolean }
  | { type: 'wake'; wake: EaWake }
  | { type: 'captions-cleared' }
  | { type: 'audio-blocked'; blocked: boolean }
  | { type: 'route'; event: RouteEvent }

const QUIET: CallSignals = { userSpeaking: false, botSpeaking: false, micHeld: false, latency: null }
const NO_TRACKS: CallTracks = { local: null, bot: null }

export const initialCallState: CallState = {
  phase: 'idle',
  error: null,
  failure: null,
  captions: initialCaptions,
  signals: QUIET,
  micOn: true,
  outputMuted: false,
  tracks: NO_TRACKS,
  wake: null,
  auto: false,
  audioBlocked: false,
  userStoppedAt: null,
  replies: { count: 0, totalMs: 0 },
  lastEnd: null,
  route: { inputs: [], reroutes: 0 },
}

/** A kind joins the list when it differs from the last one, up to the cap. */
function withRoute(route: CallRoute, event: RouteEvent): CallRoute {
  if (event.kind === 'rerouted') {
    return { ...route, reroutes: route.reroutes + 1 }
  }
  const { inputs } = route
  if (inputs.at(-1) === event.input || inputs.length >= EA_MAX_INPUTS) {
    return route
  }
  return { ...route, inputs: [...inputs, event.input] }
}

const withCaption = (state: CallState, event: CaptionEvent): CallState => ({
  ...state,
  captions: captionsReducer(state.captions, event),
})

function ended(state: CallState, action: Extract<CallAction, { type: 'ended' }>): CallState {
  const { at, error, reason, hidden } = action
  if (state.phase === 'idle' && error === null) {
    return state
  }
  const live = state.phase === 'connected'
  const marked = live ? withCaption(state, { type: 'marker', text: 'Call ended', at }) : state
  const signals = { ...QUIET, latency: state.signals.latency }
  const failure = error === null ? null : { at, dropped: live, auto: state.auto }
  const phase = error === null ? 'idle' : 'error'
  const lastEnd = live ? { reason, at, hidden } : state.lastEnd
  return { ...marked, phase, error, failure, signals, tracks: NO_TRACKS, wake: null, lastEnd }
}

function botSpeaking(state: CallState, speaking: boolean, at: number): CallState {
  const captioned = withCaption(state, { type: speaking ? 'bot-started' : 'bot-stopped' })
  const stoppedAt = state.userStoppedAt
  if (!speaking || stoppedAt === null) {
    return { ...captioned, signals: { ...state.signals, botSpeaking: speaking } }
  }
  const last = at - stoppedAt
  const replies = { count: state.replies.count + 1, totalMs: state.replies.totalMs + last }
  const latency = { last, average: replies.totalMs / replies.count }
  return { ...captioned, signals: { ...state.signals, botSpeaking: true, latency }, userStoppedAt: null, replies }
}

const MEDIA_ACTIONS = new Set<CallAction['type']>(['mic', 'output-muted', 'audio-blocked', 'route'])
type MediaAction = Extract<CallAction, { type: 'mic' | 'output-muted' | 'audio-blocked' | 'route' }>

const isMedia = (action: CallAction): action is MediaAction => MEDIA_ACTIONS.has(action.type)

/** The microphone, the EA's voice and the route the call takes. */
function withMedia(state: CallState, action: MediaAction): CallState {
  switch (action.type) {
    case 'mic':
      return { ...state, micOn: action.on }
    case 'output-muted':
      return { ...state, outputMuted: action.muted }
    case 'audio-blocked':
      return { ...state, audioBlocked: action.blocked }
    case 'route': {
      const route = withRoute(state.route, action.event)
      return route === state.route ? state : { ...state, route }
    }
  }
}

export function callReducer(state: CallState, action: CallAction): CallState {
  if (isMedia(action)) {
    return withMedia(state, action)
  }
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        phase: 'connecting',
        error: null,
        failure: null,
        captions: initialCaptions,
        signals: QUIET,
        micOn: true,
        tracks: NO_TRACKS,
        wake: null,
        auto: action.auto,
        audioBlocked: false,
        userStoppedAt: null,
        replies: initialCallState.replies,
        route: initialCallState.route,
      }
    case 'connected':
      return withCaption({ ...state, phase: 'connected' }, { type: 'marker', text: 'Call started', at: action.at })
    case 'ended':
      return ended(state, action)
    case 'caption':
      return withCaption(state, action.event)
    case 'user-speaking':
      return {
        ...state,
        signals: { ...state.signals, userSpeaking: action.speaking },
        userStoppedAt: action.speaking ? state.userStoppedAt : action.at,
      }
    case 'bot-speaking':
      return botSpeaking(state, action.speaking, action.at)
    case 'mic-held':
      return { ...state, signals: { ...state.signals, micHeld: action.held } }
    case 'tracks':
      return { ...state, tracks: action.tracks }
    case 'wake':
      return { ...state, wake: action.wake }
    case 'captions-cleared':
      return { ...state, captions: initialCaptions }
  }
}

export const callActive = (phase: CallPhase) => phase === 'connecting' || phase === 'connected'

/** The call is live but the EA waits for its wake phrase. */
export const asleep = ({ phase, wake }: CallState) => phase === 'connected' && wake?.enabled === true && !wake.awake

export function latestLine(captions: CaptionState): SpeechItem | null {
  const item = captions.items.findLast((entry) => entry.kind === 'user' || entry.kind === 'bot')
  return item?.kind === 'user' || item?.kind === 'bot' ? item : null
}

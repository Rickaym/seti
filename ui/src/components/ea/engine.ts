import {
  PipecatClient,
  RTVIEvent,
  TransportStartError,
  type BotOutputData,
  type LLMFunctionCallInProgressData,
  type LLMFunctionCallStoppedData,
  type Participant,
  type RTVIMessage,
  type UserInputData,
} from '@pipecat-ai/client-js'
import { SmallWebRTCTransport, WavMediaManager } from '@pipecat-ai/small-webrtc-transport'
import {
  eaActionMessage,
  eaCallEndMessage,
  eaWakeMessage,
  type EaCallEndReason,
  type EaRequestData,
} from '@seti/shared'
import { withMicDefaults } from './audio-prefs'
import type { CallAction } from './call-state'
import type { CallHandlers, LiveCall } from './call-store'
import { responseError } from './ice'
import { describeBotError } from './media'
import { everySecond } from './ticker'

const OFFER_PATH = '/api/ea/offer'

const ICE_FAILED =
  'The connection could not find a network path to the EA. Hover EA in the status bar and test the relay.'
const BOT_ERROR_TTL_MS = 10_000

interface MicManager {
  updateMic: (micId: string) => Promise<void>
}

/** The package types this class against an unpublished module, so it reads as unresolved. */
const WavManager = WavMediaManager as unknown as new () => MicManager

/** Switches run one at a time: the manager's own fallback on unplug can overlap ours and break it. */
function micManager(): MicManager {
  const manager = new WavManager()
  const update = manager.updateMic.bind(manager)
  let queue = Promise.resolve()
  manager.updateMic = async (micId) => {
    queue = queue.then(async () => update(micId)).catch(() => undefined)
    return queue
  }
  return manager
}

function withoutDevice(constraints: MediaTrackConstraints): MediaTrackConstraints {
  const copy = { ...constraints }
  delete copy.deviceId
  return copy
}

let micDefaults: () => MediaTrackConstraints = () => ({})
let micDefaultsInstalled = false

/** The recorder asks for a bare microphone, so requests get the chosen device and processing. */
function installMicDefaults(defaults: () => MediaTrackConstraints): void {
  micDefaults = defaults
  if (micDefaultsInstalled) {
    return
  }
  micDefaultsInstalled = true
  const media = navigator.mediaDevices
  const getUserMedia = media.getUserMedia.bind(media)
  media.getUserMedia = async (request) => getUserMedia(withMicDefaults(request, micDefaults()))
}

interface TransportInternals {
  attemptReconnection: (recreate?: boolean) => Promise<void>
  stop: (error?: Error) => Promise<void>
  buildTransportStartError: () => Error
  addUserMedia: () => Promise<void>
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  _lastNegotiationError: unknown
}

/** A switched microphone is a new track, which the peer connection only sends once handed it. */
function sendLocalAudio(transport: SmallWebRTCTransport): void {
  const internals = transport as unknown as TransportInternals
  if (internals.pc !== null && internals.pc.signalingState !== 'closed') {
    internals.addUserMedia().catch(() => undefined)
  }
}

/**
 * A reconnect that recreates the peer connection would start a new bot session, so the call ends
 * instead. A path that is only disconnected, as in a short network stall, gets until the browser
 * declares it failed, about 30 s, rather than the transport's 5 s.
 */
function buildTransport(iceServers: RTCIceServer[], onIceFailure: () => void): SmallWebRTCTransport {
  const transport = new SmallWebRTCTransport({
    iceServers,
    waitForICEGathering: true,
    mediaManager: micManager(),
  })
  const internals = transport as unknown as TransportInternals
  const reconnect = internals.attemptReconnection.bind(transport)
  internals.attemptReconnection = async (recreate = false) => {
    if (!recreate) {
      await reconnect(false)
      return
    }
    if (internals.pc?.iceConnectionState === 'disconnected') {
      return
    }
    if (internals._lastNegotiationError === null) {
      onIceFailure()
    }
    await internals.stop(internals.buildTransportStartError())
  }
  return transport
}

/** The offer request answers with the raw Response when it is refused, sometimes as the cause. */
async function connectError(e: unknown): Promise<string> {
  const cause: unknown = e instanceof Error ? e.cause : undefined
  if (e instanceof Response) {
    return responseError(e, 'The offer')
  }
  if (cause instanceof Response) {
    return responseError(cause, 'The offer')
  }
  const text = e instanceof Error ? e.message : String(e)
  return text.trim() === '' ? 'Could not connect to the EA.' : text
}

let swallowing = false

/** The transport rejects an internal promise nobody awaits when a call stops while connecting. */
function swallowTransportStartErrors(): void {
  if (swallowing) {
    return
  }
  swallowing = true
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof TransportStartError) {
      event.preventDefault()
    }
  })
}

function listen(client: PipecatClient, dispatch: (action: CallAction) => void): void {
  const caption = (event: Extract<CallAction, { type: 'caption' }>['event']) => {
    dispatch({ type: 'caption', event })
  }
  let tracks: { local: MediaStreamTrack | null; bot: MediaStreamTrack | null } = { local: null, bot: null }
  // Remote tracks come without a participant, and the transport lists only local tracks.
  client.on(RTVIEvent.TrackStarted, (track: MediaStreamTrack, participant?: Participant) => {
    if (track.kind !== 'audio') {
      return
    }
    tracks = participant?.local === true ? { ...tracks, local: track } : { ...tracks, bot: track }
    dispatch({ type: 'tracks', tracks })
  })
  client.on(RTVIEvent.UserStartedSpeaking, () => {
    dispatch({ type: 'user-speaking', speaking: true, at: Date.now() })
  })
  client.on(RTVIEvent.UserStoppedSpeaking, () => {
    dispatch({ type: 'user-speaking', speaking: false, at: Date.now() })
  })
  client.on(RTVIEvent.BotStartedSpeaking, () => {
    dispatch({ type: 'bot-speaking', speaking: true, at: Date.now() })
  })
  client.on(RTVIEvent.BotStoppedSpeaking, () => {
    dispatch({ type: 'bot-speaking', speaking: false, at: Date.now() })
  })
  client.on(RTVIEvent.UserMuteStarted, () => {
    dispatch({ type: 'mic-held', held: true })
  })
  client.on(RTVIEvent.UserMuteStopped, () => {
    dispatch({ type: 'mic-held', held: false })
  })
  client.on(RTVIEvent.UserInput, (data: UserInputData) => {
    caption({ type: 'user', text: data.text, final: data.final, at: Date.now() })
  })
  client.on(RTVIEvent.BotOutput, (data: BotOutputData) => {
    const progress = data.spoken_progress ?? null
    if (data.will_be_spoken === false || progress === null) {
      return
    }
    caption({ type: 'bot-segment', segment: data.segment_id ?? 0, spoken: progress.accumulated_text, at: Date.now() })
  })
  client.on(RTVIEvent.LLMFunctionCallInProgress, (data: LLMFunctionCallInProgressData) => {
    caption({ type: 'call-started', tool: data.function_name ?? 'tool', callId: data.tool_call_id, at: Date.now() })
  })
  client.on(RTVIEvent.LLMFunctionCallStopped, (data: LLMFunctionCallStoppedData) => {
    const tool = data.function_name ?? 'tool'
    caption({ type: 'call-stopped', tool, callId: data.tool_call_id, cancelled: data.cancelled })
  })
  client.on(RTVIEvent.ServerMessage, (data: unknown) => {
    const parsed = eaActionMessage.safeParse(data)
    if (parsed.success) {
      caption({ type: 'action', action: parsed.data, at: Date.now() })
    }
    const wake = eaWakeMessage.safeParse(data)
    if (wake.success) {
      const { enabled, awake, phrase, local } = wake.data
      dispatch({ type: 'wake', wake: { enabled, awake, phrase, local } })
    }
  })
}

/** The bot drops the EA's voice 3 s after its last ping, and the transport pings on page timers. */
function keepAlive(transport: SmallWebRTCTransport): () => void {
  const internals = transport as unknown as TransportInternals
  return everySecond(() => {
    const channel = internals.dc
    if (channel?.readyState === 'open') {
      channel.send(`ping: ${String(Date.now())}`)
    }
  })
}

interface EndNote {
  text: string | null
  reason: EaCallEndReason
  at: number
}

/** A pipecat client over SmallWebRTC; what happens shortly before a drop explains it. */
export function createCall(
  iceServers: RTCIceServer[],
  { dispatch, dropped }: CallHandlers,
  mic: () => MediaTrackConstraints,
): LiveCall {
  swallowTransportStartErrors()
  let systemDefault = false
  installMicDefaults(() => (systemDefault ? withoutDevice(mic()) : mic()))
  let stopping = false
  let note: EndNote | null = null
  const recent = () => (note !== null && Date.now() - note.at < BOT_ERROR_TTL_MS ? note : null)
  const recentReason = () => recent()?.text ?? null
  const transport = buildTransport(iceServers, () => {
    note = { text: ICE_FAILED, reason: 'ice-failed', at: Date.now() }
  })
  let choseDevice = false
  let stopPings: () => void = () => undefined

  const client = new PipecatClient({
    transport,
    enableMic: true,
    enableCam: false,
    callbacks: {
      onDisconnected: () => {
        stopPings()
        if (!stopping) {
          dropped(recentReason(), recent()?.reason ?? 'server-closed')
        }
      },
    },
  })
  client.on(RTVIEvent.Error, (message: RTVIMessage) => {
    const text = describeBotError(message.data)
    if (text !== null) {
      note = { text, reason: 'bot-error', at: Date.now() }
    }
  })
  client.on(RTVIEvent.ServerMessage, (data: unknown) => {
    if (eaCallEndMessage.safeParse(data).success) {
      note = { text: null, reason: 'bot-idle', at: Date.now() }
    }
  })
  client.on(RTVIEvent.TrackStarted, (track: MediaStreamTrack, participant?: Participant) => {
    if (track.kind === 'audio' && participant?.local === true) {
      sendLocalAudio(transport)
    }
  })
  client.on(RTVIEvent.DeviceError, () => {
    if (choseDevice) {
      choseDevice = false
      systemDefault = true
      client.updateMic('')
    }
  })
  listen(client, dispatch)

  return {
    connect: async (requestData: EaRequestData) => {
      await client.initDevices()
      stopPings = keepAlive(transport)
      await client.connect({ webrtcRequestParams: { endpoint: OFFER_PATH, requestData } })
    },
    stop: async () => {
      stopping = true
      stopPings()
      client.tracks().local.audio?.stop()
      await client.disconnect().catch(() => undefined)
    },
    enableMic: (on: boolean) => {
      client.enableMic(on)
    },
    switchMic: (deviceId: string | null) => {
      choseDevice = deviceId !== null
      systemDefault = false
      client.updateMic(deviceId ?? '')
    },
    send: (type: string) => {
      client.sendClientMessage(type)
    },
    failure: async (e: unknown) => recentReason() ?? connectError(e),
  }
}

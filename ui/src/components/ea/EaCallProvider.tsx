import type { EaHistoryPage } from '@seti/shared'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet } from '@/api'
import { CallSession } from './CallSession'
import { browserPrefsStorage, canSetSink } from './audio-prefs'
import { AudioDeviceStore, micKey } from './audio-store'
import { AutoJoin, browserMicPermission, lockLead } from './auto-join'
import {
  EaAudioContext,
  EaAutoJoinContext,
  EaCallContext,
  EaHistoryContext,
  useEaAudio,
  useEaCall,
} from './call-context'
import { pageHidden } from './call-end'
import { callActive } from './call-state'
import { EaCallStore } from './call-store'
import { browserClock } from './clock'
import { EaHistoryStore } from './history-store'
import { loadIceServers } from './ice'
import { mediaIssue, micError, probeMicrophone } from './media'

/** The call reads the audio choices, and the choices ask whether a call uses the devices. */
function createStores() {
  let call: EaCallStore | null = null
  const audio = new AudioDeviceStore({
    media: 'mediaDevices' in navigator ? navigator.mediaDevices : null,
    storage: browserPrefsStorage,
    sinkSupported: canSetSink(typeof HTMLMediaElement === 'undefined' ? undefined : HTMLMediaElement.prototype),
    inUse: () => call !== null && callActive(call.getSnapshot().phase),
    onLost: (message) => {
      toast.warning(message)
    },
    describeError: micError,
  })
  call = new EaCallStore({
    loadEngine: async () => import('./engine'),
    preflight: mediaIssue,
    iceServers: loadIceServers,
    probeMicrophone: async () => probeMicrophone(audio.micConstraints()),
    mic: audio.micConstraints,
    requestData: () => browserClock(),
    now: Date.now,
    hidden: pageHidden,
  })
  const autoJoin = new AutoJoin({
    call,
    lead: lockLead('seti-ea-call'),
    micPermission: browserMicPermission,
    later: (task, ms) => {
      const timer = window.setTimeout(task, ms)
      return () => {
        window.clearTimeout(timer)
      }
    },
    now: Date.now,
  })
  return { call, audio, autoJoin }
}

const createHistory = () =>
  new EaHistoryStore({
    load: async () => apiGet<EaHistoryPage>('/ea/history'),
    clear: async () => apiDelete('/ea/history'),
    later: (task, ms) => {
      window.setTimeout(task, ms)
    },
  })

/** Plays the element, noting when the browser wants a user gesture first. */
function play(element: HTMLAudioElement, store: EaCallStore): void {
  element.play().then(
    () => {
      if (element.srcObject !== null) {
        store.setAudioBlocked(false)
      }
    },
    (e: unknown) => {
      if (e instanceof DOMException && e.name === 'NotAllowedError' && element.srcObject !== null) {
        store.setAudioBlocked(true)
      }
    },
  )
}

/** While the browser blocks the EA's voice, the next press or key anywhere lets it play. */
function useAudioUnblock(store: EaCallStore, blocked: boolean): void {
  useEffect(() => {
    if (!blocked) {
      return
    }
    const retry = () => {
      store.resumeAudio()
    }
    const options = { capture: true, once: true }
    window.addEventListener('pointerdown', retry, options)
    window.addEventListener('keydown', retry, options)
    return () => {
      window.removeEventListener('pointerdown', retry, options)
      window.removeEventListener('keydown', retry, options)
    }
  }, [store, blocked])
}

/** Plays the bot's audio for the whole app; muting it keeps the call and the captions going. */
function BotAudio({ store }: { store: EaCallStore }) {
  const { tracks, outputMuted, audioBlocked } = useEaCall()
  const { speaker, sinkSupported } = useEaAudio()
  const track = tracks.bot
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    store.setAudioUnlock(() => {
      const element = audio.current
      if (element !== null) {
        play(element, store)
      }
    })
    return () => {
      store.setAudioUnlock(null)
    }
  }, [store])
  useEffect(() => {
    const element = audio.current
    if (element === null) {
      return
    }
    element.srcObject = track === null ? null : new MediaStream([track])
    if (track !== null) {
      play(element, store)
    }
  }, [track, store])
  useAudioUnblock(store, audioBlocked)
  useEffect(() => {
    const element = audio.current
    if (element === null || !sinkSupported) {
      return
    }
    element.setSinkId(speaker.id ?? '').catch(async () => element.setSinkId('').catch(() => undefined))
  }, [speaker.id, sinkSupported])
  // eslint-disable-next-line jsx-a11y/media-has-caption -- the EA chat carries the transcript
  return <audio ref={audio} autoPlay muted={outputMuted} className="hidden" data-testid="ea-audio" />
}

/** Tells the history when a call ends, so the EA chat picks up its last turns. */
function FollowCalls({ history }: { history: EaHistoryStore }) {
  const active = callActive(useEaCall().phase)
  const was = useRef(false)
  useEffect(() => {
    if (!active && was.current) {
      history.callEnded()
    }
    was.current = active
  }, [active, history])
  return null
}

/** Moves a live call to the chosen microphone or processing, and lists devices once it is live. */
function FollowMic({ store, audio }: { store: EaCallStore; audio: AudioDeviceStore }) {
  const connected = useEaCall().phase === 'connected'
  const state = useEaAudio()
  const key = micKey(state)
  const micId = state.mic.id
  const applied = useRef<string | null>(null)
  useEffect(() => {
    if (!connected) {
      applied.current = null
      return
    }
    if (applied.current === null) {
      applied.current = key
      void audio.refresh()
    } else if (applied.current !== key) {
      applied.current = key
      store.switchMic(micId)
    }
  }, [connected, key, micId, store, audio])
  return null
}

/** Holds the EA call above the panels, so it survives navigation; unmounting ends it. */
export function EaCallProvider({ children }: { children: ReactNode }) {
  const [{ call: store, audio, autoJoin }] = useState(createStores)
  const [history] = useState(createHistory)
  useEffect(
    () => () => {
      void store.hangUp('page-closed')
    },
    [store],
  )
  useEffect(() => audio.start(), [audio])
  useEffect(() => autoJoin.start(), [autoJoin])
  return (
    <EaCallContext value={store}>
      <EaAudioContext value={audio}>
        <EaAutoJoinContext value={autoJoin}>
          <EaHistoryContext value={history}>
            <BotAudio store={store} />
            <CallSession store={store} />
            <FollowCalls history={history} />
            <FollowMic store={store} audio={audio} />
            {children}
          </EaHistoryContext>
        </EaAutoJoinContext>
      </EaAudioContext>
    </EaCallContext>
  )
}

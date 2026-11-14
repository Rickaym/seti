import { useEffect } from 'react'
import type { EaCallStore } from './call-store'

/** Chrome also takes the call controls, which the DOM types do not list yet. */
type Handlers = Partial<Record<MediaSessionAction | 'hangup' | 'togglemicrophone', MediaSessionActionHandler | null>>

/** Sets each handler the browser knows; older browsers throw on actions they do not. */
function setHandlers(session: MediaSession, handlers: Handlers): void {
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action as MediaSessionAction, handler ?? null)
    } catch {
      // This browser offers no such control.
    }
  }
}

/** Mute and hang up as media controls, so the phone treats the call as live media. */
function callHandlers(store: EaCallStore): Handlers {
  const setMic = (on: boolean) => () => {
    store.setMic(on)
  }
  const hangUp = () => {
    void store.hangUp()
  }
  return {
    hangup: hangUp,
    stop: hangUp,
    togglemicrophone: () => {
      store.setMic(!store.getSnapshot().micOn)
    },
    pause: setMic(false),
    play: setMic(true),
  }
}

const cleared = (handlers: Handlers): Handlers => Object.fromEntries(Object.keys(handlers).map((key) => [key, null]))

/** Shows the live call as media, with Mute and Hang up, from the lock screen and notifications. */
export function useCallMediaSession(store: EaCallStore, connected: boolean, micOn: boolean): void {
  useEffect(() => {
    if (!connected || !('mediaSession' in navigator)) {
      return undefined
    }
    const session = navigator.mediaSession
    const handlers = callHandlers(store)
    session.metadata = new MediaMetadata({
      title: 'EA call',
      artist: 'Seti',
      artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    })
    setHandlers(session, handlers)
    return () => {
      session.metadata = null
      session.playbackState = 'none'
      setHandlers(session, cleared(handlers))
    }
  }, [store, connected])
  useEffect(() => {
    if (!connected || !('mediaSession' in navigator)) {
      return
    }
    const session = navigator.mediaSession
    session.playbackState = micOn ? 'playing' : 'paused'
    // Chrome returns nothing here rather than the promise the standard describes.
    Promise.resolve()
      .then(async () => session.setMicrophoneActive(micOn))
      .catch(() => undefined)
  }, [connected, micOn])
}

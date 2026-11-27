import type { EaCallEndInput } from '@seti/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiBeacon } from '@/api'
import { setCallLive } from '@/lib/live-call'
import { AwayWatch } from './away'
import { useEaCall } from './call-context'
import { CallEndRecorder, pageHidden, sessionTabStorage } from './call-end'
import type { CallEnd, CallRoute } from './call-state'
import type { EaCallStore } from './call-store'
import { useCallMediaSession } from './media-session'

const sendEnd = (report: EaCallEndInput) => {
  apiBeacon('/ea/call-end', report)
}

/** Reports each call end to the audit log; one the page closed on, when the tab opens Seti again. */
function useCallEnds(connected: boolean, auto: boolean, lastEnd: CallEnd | null, route: CallRoute): void {
  const [recorder] = useState(
    () => new CallEndRecorder({ send: sendEnd, storage: sessionTabStorage, now: Date.now, hidden: pageHidden }),
  )
  useEffect(() => {
    recorder.recover()
    document.addEventListener('visibilitychange', recorder.visibility)
    return () => {
      document.removeEventListener('visibilitychange', recorder.visibility)
    }
  }, [recorder])
  useEffect(() => {
    if (connected) {
      recorder.connected(auto)
    }
  }, [recorder, connected, auto])
  useEffect(() => {
    recorder.route(route)
  }, [recorder, route, connected])
  useEffect(() => {
    if (lastEnd !== null) {
      recorder.ended(lastEnd.reason, lastEnd.quality)
    }
  }, [recorder, lastEnd])
}

/** Reopens a microphone the system dropped while away, and says when the EA heard nothing. */
function useAwayWatch(store: EaCallStore, connected: boolean): void {
  const [watch] = useState(
    () =>
      new AwayWatch({
        hearing: store.hearing,
        micOn: () => store.getSnapshot().micOn,
        reopen: store.reroute,
        note: (text) => toast(text),
        now: Date.now,
      }),
  )
  useEffect(() => {
    if (!connected) {
      return undefined
    }
    const changed = () => void (pageHidden() ? watch.hidden() : watch.shown())
    document.addEventListener('visibilitychange', changed)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      watch.reset()
    }
  }, [watch, connected])
}

/** Keeps a live call going as media the phone shows, and records how each call ends. */
export function CallSession({ store }: { store: EaCallStore }) {
  const { phase, micOn, auto, lastEnd, route } = useEaCall()
  const connected = phase === 'connected'
  useEffect(() => {
    setCallLive(phase === 'connecting' || connected)
  }, [phase, connected])
  useCallMediaSession(store, connected, micOn)
  useCallEnds(connected, auto, lastEnd, route)
  useAwayWatch(store, connected)
  return null
}

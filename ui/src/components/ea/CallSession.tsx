import type { EaCallEndInput } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiBeacon } from '@/api'
import { useEaCall } from './call-context'
import { CallEndRecorder, pageHidden, sessionTabStorage } from './call-end'
import type { CallEnd } from './call-state'
import type { EaCallStore } from './call-store'
import { useCallMediaSession } from './media-session'

const sendEnd = (report: EaCallEndInput) => {
  apiBeacon('/ea/call-end', report)
}

/** Reports each call end to the audit log; one the page closed on, when the tab opens Seti again. */
function useCallEnds(connected: boolean, auto: boolean, lastEnd: CallEnd | null): void {
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
    if (lastEnd !== null) {
      recorder.ended(lastEnd.reason)
    }
  }, [recorder, lastEnd])
}

/** Keeps a live call going as media the phone shows, and records how each call ends. */
export function CallSession({ store }: { store: EaCallStore }) {
  const { phase, micOn, auto, lastEnd } = useEaCall()
  const connected = phase === 'connected'
  useCallMediaSession(store, connected, micOn)
  useCallEnds(connected, auto, lastEnd)
  return null
}

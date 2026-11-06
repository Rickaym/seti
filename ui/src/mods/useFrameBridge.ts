import type { ModBridgeCall, ModBridgeOut, ModError, ModErrorCode, ModFrameReportInput } from '@seti/shared'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { apiPost, RequestError } from '@/api'
import { ModBridge, type BridgeHost } from './bridge'
import { themeMessage } from './theme-vars'

type Answer = { ok: true; value: unknown } | { ok: false; error: ModError }

const CODES: Readonly<Record<number, ModErrorCode>> = { 400: 'invalid', 403: 'denied', 404: 'denied', 429: 'limit' }

/** A view's call relayed with the user's session; the server runs it as the mod. */
async function relay(modId: string, view: string, call: ModBridgeCall): Promise<Answer> {
  const body = { ...call, view, t: undefined, id: undefined }
  try {
    return await apiPost<Answer>(`/mod-frames/${modId}/call`, body)
  } catch (e) {
    const code = e instanceof RequestError ? (CODES[e.status] ?? 'failed') : 'failed'
    return { ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } }
  }
}

const STOPPED: Readonly<Record<ModFrameReportInput['reason'], string>> = {
  navigated: 'tried to leave its page and was stopped',
  flooded: 'was stopped: it sent too many messages',
  oversized: 'was stopped: it sent messages that were too large',
  malformed: 'was stopped',
}

/** What the frame's page does for the view, each of which Seti draws or decides. */
export interface FrameActions {
  modId: string
  modName: string
  view: string
  resize: (height: number) => void
  link: (url: string) => void
  /** Sent on connect and whenever it changes. */
  context: ModBridgeOut
  /** Sent once the view says it is ready, such as the file a viewer shows. */
  onReady?: (send: (message: ModBridgeOut) => void) => void
}

const THEME_ATTRIBUTES = ['class', 'data-theme', 'data-flavour', 'data-accent']

/**
 * Seti's end of a mod frame, mounted once per frame instance: a fresh nonce, the window
 * listener that hands the port over, the theme and context the view follows, and why the view
 * was stopped.
 */
export function useFrameBridge(frame: RefObject<HTMLIFrameElement | null>, actions: FrameActions) {
  const latest = useRef(actions)
  useEffect(() => {
    latest.current = actions
  })
  const [nonce] = useState(() => crypto.randomUUID())
  const [ready, setReady] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const bridge = useRef<ModBridge | null>(null)
  /** Loads the frame finished before the bridge existed, which it still counts. */
  const early = useRef(0)

  useEffect(() => {
    const host: BridgeHost = {
      call: async (call) => relay(latest.current.modId, latest.current.view, call),
      resize: (height) => {
        latest.current.resize(height)
      },
      open: (route) => {
        window.location.assign(route)
      },
      link: (url) => {
        latest.current.link(url)
      },
      ready: () => {
        setReady(true)
      },
      report: (reason, stop) => {
        const { modId, modName, view } = latest.current
        if (stop) {
          setStopped(`${modName}'s view ${STOPPED[reason]}`)
        }
        apiPost(`/mod-frames/${modId}/report`, { view, reason }).catch(() => undefined)
      },
    }
    const current = new ModBridge(nonce, latest.current.modId, host)
    bridge.current = current
    for (; early.current > 0; early.current -= 1) {
      current.loaded()
    }
    const onMessage = (event: MessageEvent) => {
      if (current.hello(event, frame.current?.contentWindow ?? null)) {
        current.send(latest.current.context)
        current.send(themeMessage())
      }
    }
    // eslint-disable-next-line sonarjs/post-message -- every sandboxed frame is "null"; hello checks the source window
    window.addEventListener('message', onMessage)
    const observer = new MutationObserver(() => {
      current.send(themeMessage())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES })
    return () => {
      window.removeEventListener('message', onMessage)
      observer.disconnect()
      current.close()
      bridge.current = null
    }
  }, [nonce, frame])

  const contextKey = JSON.stringify(actions.context)
  useEffect(() => {
    bridge.current?.send(latest.current.context)
  }, [contextKey])

  useEffect(() => {
    if (ready) {
      latest.current.onReady?.((message) => {
        bridge.current?.send(message)
      })
    }
  }, [ready])

  const loaded = () => {
    if (bridge.current === null) {
      early.current += 1
    } else {
      bridge.current.loaded()
    }
  }
  return { nonce, ready, stopped, loaded }
}

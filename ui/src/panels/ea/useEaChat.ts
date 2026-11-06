import type { EaChatEvent, EaChatInput, EaHistoryEntry, EaHistoryPage } from '@seti/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText, RequestError } from '@/api'
import { useEaCall, useEaHistory, useEaHistoryStore } from '@/components/ea/call-context'
import { callActive } from '@/components/ea/call-state'
import { browserClock } from '@/components/ea/clock'
import { responseError } from '@/components/ea/ice'
import { useClientSend } from '@/hooks/useClientSend'
import { startPolling } from '@/lib/poll-loop'
import { isRetryable, withRetry } from '@/lib/send-retry'
import { applyEvent, type LiveExchange } from './rows'
import { readEvents } from './stream'

const CHAT_PATH = '/api/ea/chat'
const PAGE = 200
/** How often the chat picks up spoken turns while a call runs. */
const CALL_POLL_MS = 4000
/** Time for the EA to store what it had said after a reply is stopped. */
const STOP_SETTLE_MS = 1200
const FAILED = 'The EA could not answer'

interface Older {
  entries: EaHistoryEntry[]
  hasOlder: boolean
  epoch: number
}

export interface EaChat {
  entries: readonly EaHistoryEntry[]
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => Promise<boolean>
  live: LiveExchange | null
  replying: boolean
  /** True while a typed message waits to be sent again after a network fault. */
  retrying: boolean
  /** Resolves false when nothing was stored, so the text can go back into the composer. */
  send: (text: string) => Promise<boolean>
  stop: () => void
}

const wait = async (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })

async function post(text: string, clientId: string, signal: AbortSignal): Promise<Response> {
  const body: EaChatInput = { text, requestData: browserClock(), client_id: clientId }
  return fetch(CHAT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

interface Failure {
  title: string
  detail: string
}

/** Shows the streamed reply; a gateway error throws so the send retries with the same id. */
async function reply(res: Response, answered: () => void, show: (event: EaChatEvent) => void): Promise<Failure | null> {
  if (!res.ok || res.body === null) {
    const detail = await responseError(res, 'The chat')
    if (isRetryable({ status: res.status })) {
      throw new RequestError(res.status, detail)
    }
    return { title: FAILED, detail }
  }
  answered()
  for await (const event of readEvents(res.body)) {
    if (event.type === 'error') {
      return { title: event.title, detail: event.detail }
    }
    show(event)
  }
  return null
}

/** The EA conversation as the chat shows it, and typed messages with their streamed replies. */
export function useEaChat(): EaChat {
  const store = useEaHistoryStore()
  const history = useEaHistory()
  const calling = callActive(useEaCall().phase)
  const [older, setOlder] = useState<Older | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [live, setLive] = useState<LiveExchange | null>(null)
  const [replying, setReplying] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const { retrying, run } = useClientSend()

  useEffect(() => {
    void store.refresh()
  }, [store])

  useEffect(() => {
    if (!calling) {
      return undefined
    }
    return startPolling(() => void store.refresh(), CALL_POLL_MS)
  }, [calling, store])

  const current = older !== null && older.epoch === history.epoch ? older : null
  const entries = useMemo(() => {
    const first = history.entries[0]?.id ?? Number.POSITIVE_INFINITY
    return current === null ? history.entries : [...current.entries.filter((e) => e.id < first), ...history.entries]
  }, [current, history.entries])

  const loadOlder = useCallback(async () => {
    const first = entries[0]?.id
    if (first === undefined) {
      return false
    }
    setLoadingOlder(true)
    try {
      const page = await apiGet<EaHistoryPage>(`/ea/history?limit=${String(PAGE)}&before=${String(first)}`)
      setOlder({ entries: [...page.entries, ...entries], hasOlder: page.has_older, epoch: history.epoch })
      return page.entries.length > 0
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      setLoadingOlder(false)
    }
  }, [entries, history.epoch])

  const send = useCallback(
    async (text: string) => {
      const controller = new AbortController()
      abort.current = controller
      setReplying(true)
      setLive({ text, at: new Date().toISOString(), parts: [] })
      const show = (event: EaChatEvent) => {
        setLive((shown) => (shown === null ? null : applyEvent(shown, event)))
      }
      try {
        const failure = await run(text, async (clientId, options) =>
          withRetry(async (signal, answered) => reply(await post(text, clientId, signal), answered, show), {
            ...options,
            signal: controller.signal,
          }),
        )
        if (failure !== null) {
          toast.error(failure.title, { description: failure.detail })
          setLive(null)
          return false
        }
        await store.refresh()
        return true
      } catch (e) {
        if (!controller.signal.aborted) {
          toast.error(FAILED, { description: errorText(e) })
          setLive(null)
          return false
        }
        await wait(STOP_SETTLE_MS)
        await store.refresh()
        setLive(null)
        return true
      } finally {
        abort.current = null
        setReplying(false)
      }
    },
    [run, store],
  )

  const stop = useCallback(() => {
    abort.current?.abort()
  }, [])

  return {
    retrying,
    entries,
    hasOlder: current?.hasOlder ?? history.hasOlder,
    loadingOlder,
    loadOlder,
    live,
    replying,
    send,
    stop,
  }
}

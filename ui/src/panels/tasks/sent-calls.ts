import { permissionRequestsSchema, type PermissionRequest, type WireRow } from '@seti/shared'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { apiGetValid } from '@/api'

/** A call the user edited and then allowed: its input as it ran, secrets redacted. */
export interface SentCall {
  input: Record<string, unknown>
}

type SentCalls = ReadonlyMap<string, SentCall>

const NONE: SentCalls = new Map()

/** The ids of the calls the transcript's edit marks say the user edited and then allowed. */
export function editedCallIds(messages: readonly WireRow[]): string[] {
  return messages.flatMap((row) =>
    row.kind === 'seti' && row.payload.edited?.call !== undefined && !row.payload.edited.denied
      ? [row.payload.edited.call]
      : [],
  )
}

/** The input a request stored as its call ran; null when it was cut short or is not an object. */
function ranInput(request: Pick<PermissionRequest, 'input'>): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(request.input)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Each edited call that ran, by its id, from the requests that held it. */
export function sentCallsOf(requests: readonly PermissionRequest[], ids: readonly string[]): SentCalls {
  const wanted = new Set(ids)
  const sent = new Map<string, SentCall>()
  for (const { call_id: id, state, edited, ...request } of requests) {
    const input = id !== null && wanted.has(id) && state === 'allowed' && edited.length > 0 ? ranInput(request) : null
    if (id !== null && input !== null) {
      sent.set(id, { input })
    }
  }
  return sent
}

/** Reads the requests behind the transcript's edited calls once their marks appear. */
export function useSentCalls(taskId: string, messages: readonly WireRow[]): SentCalls {
  const key = useMemo(() => editedCallIds(messages).join('\n'), [messages])
  const [sent, setSent] = useState<{ key: string; calls: SentCalls }>({ key: '', calls: NONE })
  useEffect(() => {
    if (key === '') {
      return undefined
    }
    const controller = new AbortController()
    apiGetValid(`/tasks/${taskId}/permission-requests`, permissionRequestsSchema, controller.signal)
      .then((requests) => {
        setSent({ key, calls: sentCallsOf(requests, key.split('\n')) })
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [taskId, key])
  return key === '' ? NONE : sent.calls
}

export const SentCallsContext = createContext<SentCalls>(NONE)

/** The call as it ran when the user edited it before allowing it; undefined for any other call. */
export const useSentCall = (callId: string | undefined): SentCall | undefined => {
  const sent = useContext(SentCallsContext)
  return callId === undefined ? undefined : sent.get(callId)
}

import type { ApiError, Envelope } from '@seti/shared'
import { RequestError, SIGN_IN_REQUIRED } from '@/api'

const API_BASE = '/api'

/** A changed body with its tag, or null when the server answered 304 for the tag sent. */
export type Conditional = { data: unknown; etag: string | null } | null

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'error' in value

async function failure(res: Response): Promise<RequestError> {
  const body: unknown = await res.json().catch(() => null)
  const detail = isApiError(body) ? body.error.detail : `Request failed (${String(res.status)})`
  return new RequestError(res.status, detail, body)
}

/** A GET that sends the tag of the body it holds; no-store keeps the browser from doing so. */
export async function getIfChanged(path: string, etag: string | null, signal: AbortSignal): Promise<Conditional> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    cache: 'no-store',
    ...(etag === null ? {} : { headers: { 'If-None-Match': etag } }),
  })
  if (res.status === 304) {
    return null
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED))
  }
  if (!res.ok) {
    throw await failure(res)
  }
  const envelope = (await res.json()) as Envelope<unknown>
  return { data: envelope.data, etag: res.headers.get('etag') }
}

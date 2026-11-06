import { parseLenient, type ApiError, type Envelope, type ResponseSchema } from '@seti/shared'
import { withRetry, type RetryOptions } from '@/lib/send-retry'

const API_BASE = '/api'

/** Fired when a browser lost its session or local sign-in, so the sign-in page shows again. */
export const SIGN_IN_REQUIRED = 'seti:sign-in-required'

export class RequestError extends Error {
  readonly status: number
  /** The parsed error body, for errors such as a save conflict that carry more than a message. */
  readonly body: unknown

  constructor(status: number, message: string, body: unknown = null) {
    super(message)
    this.status = status
    this.body = body
  }
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && 'error' in value
}

async function requestError(res: Response): Promise<RequestError> {
  const fallback = `Request failed (${String(res.status)})`
  const body: unknown = await res.json().catch(() => null)
  return new RequestError(res.status, isApiError(body) ? body.error.detail : fallback, body)
}

async function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const init: RequestInit = { method, signal: signal ?? null }
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body ?? {})
  }
  const res = await fetch(`${API_BASE}${path}`, init)
  if (res.status === 401) {
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED))
  }
  if (!res.ok) {
    throw await requestError(res)
  }
  return res
}

async function data<T>(res: Response): Promise<T> {
  const envelope = (await res.json()) as Envelope<T>
  return envelope.data
}

export const apiGet = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
  data<T>(await send('GET', path, undefined, signal))
/** Repairs already reported, so a poll repeating the same bad record logs it once. */
const reported = new Set<string>()

function reportRepairs(path: string, repairs: readonly string[]): void {
  const endpoint = path.split('?')[0] ?? path
  const fresh = repairs.filter((repair) => !reported.has(`${endpoint} ${repair}`))
  if (fresh.length === 0) {
    return
  }
  for (const repair of fresh) {
    reported.add(`${endpoint} ${repair}`)
  }
  // eslint-disable-next-line no-console -- repairs are reported to the browser console
  console.warn(`Seti repaired a malformed response from ${endpoint}: ${fresh.join('; ')}`)
}

/** Reads a body with its schema: bad fields fall back and bad items drop, logged once each. */
export function readResponse<T>(path: string, schema: ResponseSchema<T>, body: unknown): T {
  const result = parseLenient(schema, body)
  if (!result.ok) {
    throw new Error(`Unexpected response from ${path.split('?')[0] ?? path}: ${result.error}`)
  }
  reportRepairs(path, result.repairs)
  return result.data
}

/** A GET whose response drives rendering, validated so a malformed record cannot crash a view. */
export const apiGetValid = async <T>(path: string, schema: ResponseSchema<T>, signal?: AbortSignal): Promise<T> =>
  readResponse(path, schema, await apiGet<unknown>(path, signal))

export const apiPost = async <T>(path: string, body?: unknown): Promise<T> => data<T>(await send('POST', path, body))
/** A POST the user sent, keyed by its client id: it times out and retries with the same id. */
export const apiSend = async <T>(path: string, body: { client_id: string }, options: RetryOptions = {}): Promise<T> =>
  withRetry(async (signal) => data<T>(await send('POST', path, body, signal)), options)
/** Posts a request whose answer streams back, such as a side chat answer, and returns its body. */
export async function apiPostStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await send('POST', path, body, signal)
  if (res.body === null) {
    throw new RequestError(res.status, 'The answer came back empty')
  }
  return res.body
}
export const apiPut = async <T>(path: string, body?: unknown): Promise<T> => data<T>(await send('PUT', path, body))
export const apiPatch = async <T>(path: string, body?: unknown): Promise<T> => data<T>(await send('PATCH', path, body))
/** Any method to a route that answers with data, as a mod's own routes do. */
export const apiRequest = async <T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> => data<T>(await send(method, path, body))
export const apiDelete = async (path: string): Promise<void> => {
  await send('DELETE', path)
}

/** A small PUT that may outlive the page, as when it hides; its outcome does not matter. */
export function apiBeacon(path: string, body: unknown): void {
  fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined)
}

export const streamUrl = (path: string) => `${API_BASE}${path}`

/** Times one round trip to the server's empty ping endpoint, in milliseconds. */
let pings = 0

/** Round trip of one ping on the network, from the browser's resource timing when it has one. */
export async function pingApi(signal: AbortSignal): Promise<number> {
  pings += 1
  const url = new URL(`${API_BASE}/ping?n=${String(pings)}`, window.location.href).href
  const start = performance.now()
  const res = await fetch(url, { cache: 'no-store', signal })
  const elapsed = performance.now() - start
  if (!res.ok) {
    throw new RequestError(res.status, `Ping failed (${String(res.status)})`)
  }
  const timing = performance.getEntriesByName(url).at(-1)
  performance.clearResourceTimings()
  if (timing instanceof PerformanceResourceTiming && timing.responseStart > 0) {
    return timing.responseStart - timing.requestStart
  }
  return elapsed
}

/** What Chrome, Firefox and Safari say when fetch cannot reach the server at all. */
const NETWORK_FAILURE = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/u

export const errorText = (e: unknown) => {
  if (e instanceof TypeError && NETWORK_FAILURE.test(e.message)) {
    return 'Seti could not be reached'
  }
  return e instanceof Error ? e.message : String(e)
}

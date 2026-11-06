import type { ApiError, EaIce, EaIceServer } from '@seti/shared'

const ICE_PATH = '/api/ea/ice'

const REFRESH_EARLY_MS = 60_000
const UNTIMED_REUSE_MS = 5 * 60_000

const isTurnUrl = (url: string) => url.startsWith('turn:') || url.startsWith('turns:')
const urlsOf = (server: { urls: string | string[] }) => (Array.isArray(server.urls) ? server.urls : [server.urls])

/** Drops TURN urls that came without credentials, which the browser refuses outright. */
export function normalizeIceServers(servers: readonly EaIceServer[]): RTCIceServer[] {
  return servers.flatMap((server): RTCIceServer[] => {
    const urls = urlsOf(server).filter((url) => url !== '')
    const { username = '', credential = '' } = server
    if (username !== '' && credential !== '') {
      return urls.length === 0 ? [] : [{ urls, username, credential }]
    }
    const open = urls.filter((url) => !isTurnUrl(url))
    return open.length === 0 ? [] : [{ urls: open }]
  })
}

export const hasTurn = (servers: readonly RTCIceServer[]) => servers.some((server) => urlsOf(server).some(isTurnUrl))

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && 'error' in value
}

export async function apiErrorOf(res: Response): Promise<ApiError['error'] | null> {
  const body: unknown = await res.json().catch(() => null)
  return isApiError(body) ? body.error : null
}

/** The readable reason in an error response from the EA proxy, or a generic one. */
export async function responseError(res: Response, what: string): Promise<string> {
  const error = await apiErrorOf(res)
  if (error === null) {
    return `${what} failed with status ${String(res.status)}`
  }
  return error.detail === error.title ? error.title : `${error.title}: ${error.detail}`
}

let cached: { servers: RTCIceServer[]; expiresAt: number } | null = null
let pending: Promise<RTCIceServer[]> | null = null

async function fetchIceServers(): Promise<RTCIceServer[]> {
  const res = await fetch(ICE_PATH, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(await responseError(res, 'Loading ICE servers'))
  }
  const payload = (await res.json()) as Partial<EaIce>
  const servers = normalizeIceServers(Array.isArray(payload.iceServers) ? payload.iceServers : [])
  const ttl = payload.ttlSeconds
  const expiresAt =
    Date.now() + (typeof ttl === 'number' ? Math.max(ttl * 1000 - REFRESH_EARLY_MS, 0) : UNTIMED_REUSE_MS)
  cached = { servers, expiresAt }
  return servers
}

/** ICE servers from the bot, reused until their TURN credentials are about to expire. */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (cached !== null && Date.now() < cached.expiresAt) {
    return cached.servers
  }
  pending ??= fetchIceServers().finally(() => {
    pending = null
  })
  return pending
}

import { IMAGES_MAX } from './share-preview/preview.js'

/**
 * A share's page, its download, one of its stored preview images (1 to 50) or its link card:
 * the only paths anyone reaches without signing in.
 */
const SHARE_PATH = /^\/share\/([A-Za-z0-9_-]{43})(?:\/(raw|card\.png)|\/p\/([1-9]\d?))?$/

type SharePart = 'page' | 'raw' | 'image' | 'card'

export interface ShareRequest {
  token: string
  part: SharePart
  /** The image's number, for an image; else 0. */
  image: number
}

function partOf(named: string | undefined, image: string | undefined): SharePart {
  if (image !== undefined) {
    return 'image'
  }
  if (named === undefined) {
    return 'page'
  }
  return named === 'raw' ? 'raw' : 'card'
}

/** The token and part a path names, anchored on both ends, or null for any other path. */
export function parseSharePath(path: string): ShareRequest | null {
  const match = SHARE_PATH.exec(path)
  const image = match?.[3] === undefined ? 0 : Number(match[3])
  if (match === null || image > IMAGES_MAX) {
    return null
  }
  return { token: match[1] ?? '', part: partOf(match[2], match[3]), image }
}

/** A GET or HEAD of a share's page, download, image or card: the Access guard lets these through. */
export const isPublicShareRequest = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && parseSharePath(path) !== null

/** A path fit for logs: whatever follows /share/ could be a live token, so it is hidden. */
export const redactSharePath = (path: string): string => path.replace(/^\/share\/[^/]*/, '/share/[token]')

/** Any path under /share, matched or not, which gets the share headers and never the app. */
export const underShare = (path: string): boolean => path === '/share' || path.startsWith('/share/')

/** A Host header fit to name in a policy: a hostname and maybe a port, nothing else. */
const PLAIN_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/

/**
 * The origin a browser loaded a share from: Seti's public origin on its public host, else the
 * loopback host it was asked for. Null for a Host header that is not a plain host.
 */
export function shareOrigin(host: string, publicAccess: { hostname: string; origin: string } | null): string | null {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  if (publicAccess !== null && hostname === publicAccess.hostname) {
    return publicAccess.origin
  }
  return PLAIN_HOST.test(host) ? `http://${host}` : null
}

/** Set by the share handler on an audio or video share's answers; the headers step drops it. */
export const MEDIA_MARK = 'X-Seti-Share-Media'

/**
 * The page may show its own stored images: the sandbox gives it an opaque origin, so 'self'
 * matches nothing and the policy names the share's image path on the origin it came from. An
 * audio or video page may also play its own download, and nothing else.
 */
function sharePolicy(request: ShareRequest | null, origin: string | null, media: boolean): string {
  const own = request?.part === 'page' && origin !== null ? `${origin}/share/${request.token}` : null
  const images = own === null ? "'none'" : `${own}/p/`
  const policy = ['sandbox allow-downloads', "default-src 'none'", `img-src ${images}`]
  if (own !== null && media) {
    policy.push(`media-src ${own}/raw`)
  }
  policy.push("style-src 'unsafe-inline'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'")
  return policy.join('; ')
}

/** The headers of every /share response, set last so no other middleware loosens them. */
const SHARE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

/**
 * Sets the share headers. Preview images and the card may be fetched from the page's opaque
 * origin and by link preview bots, and a media share's download by its page's player, so those
 * alone are readable cross-origin.
 */
export function applyShareHeaders(headers: Headers, path: string, origin: string | null): void {
  const request = parseSharePath(path)
  const media = headers.get(MEDIA_MARK) === '1'
  headers.delete(MEDIA_MARK)
  for (const [name, value] of Object.entries(SHARE_HEADERS)) {
    headers.set(name, value)
  }
  headers.set('Content-Security-Policy', sharePolicy(request, origin, media))
  if (request?.part === 'image' || request?.part === 'card' || (media && request?.part === 'raw')) {
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  }
  headers.delete('Set-Cookie')
  headers.delete('ETag')
  headers.delete('Last-Modified')
}

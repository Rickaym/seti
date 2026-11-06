import type { Context, Handler } from 'hono'
import { currentPublicHost } from '../access.js'
import { parseRange, type ByteRange } from '../byte-range.js'
import type { PublicAccess } from '../config.js'
import { now } from '../db.js'
import { clientKey, rateLimiter } from '../rate-limit.js'
import { sharePage, sizeLabel, type LinkPreview } from '../share-page.js'
import { MEDIA_MARK, parseSharePath, shareOrigin, type ShareRequest } from '../share-path.js'
import { fillImages } from '../share-preview/preview.js'
import { unfurlerOf } from '../share-unfurlers.js'
import { sharingEnabled, tokenHash } from '../shares.js'
import { publicShares, type PublicPage, type PublicShareRow, type ShareImageRow } from '../store/shares.js'

/** Misses a client may make per minute before it gets 429s, so tokens cannot be guessed at speed. */
const MISSES_PER_MINUTE = 30
/** Requests of any kind a client may make per minute, since each reads up to a whole share. */
const REQUESTS_PER_MINUTE = 120
/** Preview images and cards a client may fetch per minute: a long PDF shows fifty at once. */
const IMAGES_PER_MINUTE = 600
const UA_MAX = 120

const NOT_FOUND = 'Not found\n'

const notFound = (c: Context) => c.text(NOT_FOUND, 404)

const tooMany = (c: Context) => c.text('Too many requests\n', 429, { 'Retry-After': '60' })

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`

/** Cloudflare's country code, kept only when it has the two-character shape Cloudflare sends. */
function countryOf(c: Context): string | null {
  const country = c.req.header('cf-ipcountry')?.trim().toUpperCase() ?? ''
  return /^[A-Z0-9]{2}$/.test(country) ? country : null
}

const userAgentOf = (c: Context) =>
  (c.req.header('user-agent') ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, UA_MAX)

async function recordView(c: Context, id: string): Promise<void> {
  const userAgent = userAgentOf(c)
  try {
    await publicShares.recordView(id, {
      at: now(),
      country: countryOf(c),
      user_agent: userAgent,
      unfurler: unfurlerOf(userAgent),
    })
  } catch (e) {
    process.stderr.write(`share: could not record a view: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/** The open share a request names; unknown, ended and switched-off shares all read as null. */
async function liveShare(target: ShareRequest | null): Promise<PublicShareRow | null> {
  const share = target === null ? undefined : await publicShares.byTokenHash(tokenHash(target.token))
  const enabled = await sharingEnabled()
  if (!enabled || share?.revoked_at !== null || share.expires_at <= now()) {
    return null
  }
  return share
}

/** A plain download is a view; a player's range fetches belong to the page view that made them. */
const isView = (c: Context) =>
  c.req.method === 'GET' &&
  c.req.header('range') === undefined &&
  !['audio', 'video', 'track'].includes(c.req.header('sec-fetch-dest') ?? '')

/** The range asked for; If-Range gets the whole file, since shares send no validators. */
const rangeOf = (c: Context, size: number): ByteRange =>
  c.req.header('if-range') === undefined ? parseRange(c.req.header('range'), size) : { kind: 'full' }

/** The bytes a GET answers with: the whole file, or only the slice read from the database. */
const bytesOf = async (share: PublicShareRow, part: { start: number; end: number } | null) =>
  part === null ? publicShares.content(share.id) : publicShares.slice(share.id, part.start, part.end - part.start + 1)

/** The download, whole or one byte range of it, read from the share tables alone. */
async function serveRaw(c: Context, share: PublicShareRow): Promise<Response | null> {
  const size = await publicShares.size(share.id)
  if (size === undefined) {
    return null
  }
  const headers: Record<string, string> = {
    'Content-Type': share.mime,
    'Content-Disposition': attachment(share.name),
    'Accept-Ranges': 'bytes',
  }
  const range = rangeOf(c, size)
  if (range.kind === 'unsatisfiable') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${String(size)}` })
  }
  const part = range.kind === 'part' ? range : null
  if (part !== null) {
    headers['Content-Range'] = `bytes ${String(part.start)}-${String(part.end)}/${String(size)}`
  }
  headers['Content-Length'] = String(part === null ? size : part.end - part.start + 1)
  const status = part === null ? 200 : 206
  if (c.req.method === 'HEAD') {
    return c.body(null, status, headers)
  }
  const content = await bytesOf(share, part)
  if (content === undefined) {
    return null
  }
  if (isView(c)) {
    await recordView(c, share.id)
  }
  return c.body(new Uint8Array(content), status, headers)
}

/** The head's link preview; with previews off it names the file and nothing else. */
function linkPreview(share: PublicShareRow, stored: PublicPage, url: string | null): LinkPreview {
  if (!share.link_preview) {
    return { url, description: null, image: null }
  }
  const description = `${stored.preview_label === '' ? 'File' : stored.preview_label}, ${sizeLabel(stored.size)}`
  return { url, description, image: url === null || !stored.card ? null : `${url}/card.png` }
}

async function servePage(c: Context, share: PublicShareRow, target: ShareRequest, access: PublicAccess | null) {
  const stored = await publicShares.page(share.id)
  if (stored === undefined) {
    return null
  }
  if (c.req.method === 'GET') {
    await recordView(c, share.id)
  }
  const origin = shareOrigin(c.req.header('host') ?? '', access)
  const body = fillImages(stored.page, stored.image_key, target.token)
  const link = linkPreview(share, stored, origin === null ? null : `${origin}/share/${target.token}`)
  const page = { name: share.name, size: stored.size, updatedAt: share.updated_at, body, link }
  return c.html(sharePage({ ...page, rawHref: `${c.req.path}/raw` }))
}

/** A stored preview image or the link card; the policy lets the page and link bots fetch them. */
async function storedImage(share: PublicShareRow, target: ShareRequest): Promise<ShareImageRow | undefined> {
  if (target.part !== 'card') {
    return publicShares.image(share.id, target.image)
  }
  const card = share.link_preview ? await publicShares.card(share.id) : undefined
  return card === undefined ? undefined : { mime: 'image/png', bytes: card }
}

async function serveImage(c: Context, share: PublicShareRow, target: ShareRequest): Promise<Response | null> {
  const image = await storedImage(share, target)
  if (image === undefined) {
    return null
  }
  return c.body(new Uint8Array(image.bytes), 200, {
    'Content-Type': image.mime,
    'Content-Length': String(image.bytes.length),
  })
}

const isMedia = (share: PublicShareRow) => share.kind === 'audio' || share.kind === 'video'

/** Marks an audio or video share's page and download, so the headers let its page play it. */
function marked(response: Response | null, share: PublicShareRow): Response | null {
  if (response !== null && isMedia(share)) {
    response.headers.set(MEDIA_MARK, '1')
  }
  return response
}

async function serve(c: Context, share: PublicShareRow, target: ShareRequest, access: PublicAccess | null) {
  switch (target.part) {
    case 'raw':
      return marked(await serveRaw(c, share), share)
    case 'page':
      return marked(await servePage(c, share, target, access), share)
    case 'image':
    case 'card':
      return serveImage(c, share, target)
  }
}

/**
 * Every request under /share: a GET or HEAD of an open share's page or download, or the same
 * 404 for everything else. It reads only the share tables, never files or other Seti state.
 */
export function publicShareHandler(access: PublicAccess | null): Handler {
  const misses = rateLimiter(MISSES_PER_MINUTE, 60_000)
  const requests = rateLimiter(REQUESTS_PER_MINUTE, 60_000)
  const images = rateLimiter(IMAGES_PER_MINUTE, 60_000)
  return async (c) => {
    const key = clientKey(c, currentPublicHost() !== null)
    const read = c.req.method === 'GET' || c.req.method === 'HEAD'
    const target = read ? parseSharePath(c.req.path) : null
    const limiter = target?.part === 'image' || target?.part === 'card' ? images : requests
    if (misses.full(key) || !limiter.take(key)) {
      return tooMany(c)
    }
    const share = await liveShare(target)
    const response = share === null || target === null ? null : await serve(c, share, target, access)
    if (response !== null) {
      return response
    }
    return misses.take(key) ? notFound(c) : tooMany(c)
  }
}

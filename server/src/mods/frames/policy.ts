import { createHash } from 'node:crypto'
import { VIEW_SHIM } from './shim.js'
import { HttpError } from '../../http.js'

/** A CSP source for one inline script: `sha256-` and the base64 digest of its exact text. */
const SCRIPT_HASH = /^sha256-[A-Za-z0-9+/]{43}=$/

/** The CSP source of an inline script's text. */
export const scriptHash = (text: string): string =>
  `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`

const SHIM_HASH = scriptHash(VIEW_SHIM)

/** Fetch destinations of a page loading in a frame; anything else is a tab or a script. */
const FRAMED = new Set(['iframe', 'frame'])

const isFramed = (fetchDest: string | undefined) => fetchDest !== undefined && FRAMED.has(fetchDest)

/**
 * A mod's page runs only the scripts it shipped with, pinned by hash, in an opaque origin with no
 * network: what it later builds from data, such as a transcript line in innerHTML, never runs.
 */
export function framePolicy(scriptHashes: readonly string[]): string {
  const pinned = scriptHashes.filter((hash) => SCRIPT_HASH.test(hash))
  const scripts = [SHIM_HASH, ...new Set(pinned)].map((hash) => `'${hash}'`).join(' ')
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
    'sandbox allow-scripts',
    "webrtc 'block'",
  ].join('; ')
}

/** Headers for a mod's page; frames only, since a tab could navigate to the web. */
export function frameHeaders(fetchDest: string | undefined, scriptHashes: readonly string[]): Record<string, string> {
  if (!isFramed(fetchDest)) {
    throw new HttpError(403, "A mod's views open only inside Seti")
  }
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': framePolicy(scriptHashes),
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-store',
  }
}

/** Comments or an XML prolog, then the doctype that keeps the page in standards mode. */
const DOCTYPE = /^(?:\s|<!--[\s\S]*?-->|<\?[^>]*>)*<!doctype[^>]*>/i

const BOM = '\uFEFF'

/** The page with the bridge shim first, after the doctype, so it runs before any mod script. */
export function frameBody(html: string): string {
  const text = html.startsWith(BOM) ? html.slice(1) : html
  const found = DOCTYPE.exec(text)
  const rest = found === null ? text : text.slice(found[0].length)
  return `${found?.[0] ?? '<!doctype html>'}<script>${VIEW_SHIM}</script>${rest}`
}

const INLINE_SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi

/**
 * The hashes of a page's inline scripts, for pages Seti itself holds, such as its test mod.
 * Installed packages bring theirs, computed with an HTML parser at install; a hash that does not
 * match what the browser parses only keeps that script from running.
 */
export const inlineScriptHashes = (html: string): string[] =>
  [...html.matchAll(INLINE_SCRIPT)].map((match) => scriptHash(match[1] ?? ''))

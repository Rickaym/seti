import { HTML_PREVIEW_MAX, isPageName, type FileMeta } from '@seti/shared'
import { HttpError } from './http.js'

/** Agent HTML gets an opaque origin and no network, as the browser skips the agent's allowlist. */
const pagePolicy = (scripts: boolean) =>
  [
    "default-src 'none'",
    scripts ? "script-src 'unsafe-inline' data: blob:" : "script-src 'none'",
    "style-src 'unsafe-inline' data:",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    scripts ? 'sandbox allow-scripts' : 'sandbox',
  ].join('; ')

/** Scripts stay off unless asked for: WebRTC is the one way out no page policy can close. */
const HTML_PREVIEW_CSP = { off: pagePolicy(false), on: pagePolicy(true) }

/** Fetch destinations of a page loading in a frame; anything else is a tab or a script. */
const FRAMED = new Set(['iframe', 'frame'])

/**
 * Whether a raw request wants the file as a sandboxed page. Only a text file a viewer serves as a
 * page becomes one, and a preview of any other file is refused rather than served as itself.
 */
export function wantsHtmlPreview(meta: FileMeta, query: { preview: boolean; download: boolean }): boolean {
  if (!query.preview || query.download) {
    return false
  }
  if (meta.kind !== 'text' || !isPageName(meta.name)) {
    throw new HttpError(403, 'No viewer serves this file as a page')
  }
  return true
}

/** Headers for an HTML page in a sandbox; frames only, since a tab could navigate to the web. */
export function htmlPreviewHeaders(
  meta: FileMeta,
  fetchDest: string | undefined,
  scripts: boolean,
): Record<string, string> {
  if (meta.size > HTML_PREVIEW_MAX) {
    throw new HttpError(413, `${meta.name} is too large to preview; download it instead`)
  }
  if (fetchDest === undefined || !FRAMED.has(fetchDest)) {
    throw new HttpError(403, "HTML previews open only inside Seti's file viewer")
  }
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': scripts ? HTML_PREVIEW_CSP.on : HTML_PREVIEW_CSP.off,
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
  }
}

/** In-memory Storage for a page whose opaque origin refuses it: its scripts run, keeping nothing. */
const STORAGE_SHIM = `<script>(function () {
  function memory() {
    var data = new Map()
    return {
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null },
      setItem: function (k, v) { data.set(String(k), String(v)) },
      removeItem: function (k) { data.delete(String(k)) },
      clear: function () { data.clear() },
      key: function (i) { var keys = Array.from(data.keys()); i = Number(i); return i >= 0 && i < keys.length ? keys[i] : null },
      get length() { return data.size },
    }
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name].length } catch (e) {
      Object.defineProperty(window, name, { value: memory(), configurable: true })
    }
  })
})()</script>`

const BOM = '\xEF\xBB\xBF'

/** Comments or an XML prolog, then the doctype that keeps the page in standards mode. */
const DOCTYPE = /^(?:\s|<!--[\s\S]*?-->|<\?[^>]*>)*<!doctype[^>]*>/i

/** The page with the storage shim before its first script when scripts are on; else unchanged. */
export function previewBody(bytes: Buffer, scripts: boolean): Buffer {
  if (!scripts) {
    return bytes
  }
  const whole = bytes.toString('latin1')
  const bom = whole.startsWith(BOM) ? BOM : ''
  const text = whole.slice(bom.length)
  const doctype = DOCTYPE.exec(text)?.[0] ?? ''
  return Buffer.from(`${bom}${doctype}${STORAGE_SHIM}${text.slice(doctype.length)}`, 'latin1')
}

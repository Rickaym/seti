/** A run of plain text, or a bare URL when `href` is set. */
export interface UrlPiece {
  text: string
  href?: string
}

const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '*', '_'])
const CLOSERS: Partial<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

const count = (text: string, char: string) => text.split(char).length - 1

/** The URL without the sentence punctuation after it; a closing bracket stays when it pairs. */
export function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.charAt(url.length - 1)
    const opener = CLOSERS[last]
    const unpaired = opener !== undefined && count(url, opener) < count(url, last)
    if (!TRAILING.has(last) && !unpaired) {
      return url
    }
    url = url.slice(0, -1)
  }
}

/** Splits plain text into text and the http and https URLs in it, punctuation left outside. */
export function urlPieces(text: string): UrlPiece[] {
  const pieces: UrlPiece[] = []
  let at = 0
  for (const match of text.matchAll(BARE_URL)) {
    const href = trimUrl(match[0])
    if (!URL.canParse(href)) {
      continue
    }
    if (match.index > at) {
      pieces.push({ text: text.slice(at, match.index) })
    }
    pieces.push({ text: href, href })
    at = match.index + href.length
  }
  if (at < text.length) {
    pieces.push({ text: text.slice(at) })
  }
  return pieces
}

/** A URL as people read it: decoded, without its scheme or a trailing slash. */
function readable(url: string): string {
  let text = url.trim()
  try {
    text = decodeURI(text)
  } catch {
    // A URL with a stray % stays as written.
  }
  return text.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

/** The link's text is its URL, as for a bare URL in Markdown, so a pill may stand in for it. */
export const textIsUrl = (text: string, href: string) => text.trim() !== '' && readable(text) === readable(href)

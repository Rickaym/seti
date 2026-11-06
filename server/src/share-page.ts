import { escapeHtml } from './share-markdown.js'
import { CARD_HEIGHT, CARD_WIDTH } from './share-preview/card.js'
import { SHARE_STYLE } from './share-preview/style.js'

/** What a link preview shows: the title alone, or with the kind, size and card when it is on. */
export interface LinkPreview {
  /** The page's absolute URL, or null when the request named no usable host. */
  url: string | null
  /** The kind and size, such as "PDF, 12 pages, 1.4 MB"; null when link previews are off. */
  description: string | null
  /** The card's absolute URL; null when off or when no card was made. */
  image: string | null
}

export interface SharePageInput {
  name: string
  size: number
  updatedAt: string
  /** The stored body, its image keys filled in. */
  body: string
  rawHref: string
  link: LinkPreview
}

const UNITS = ['bytes', 'KB', 'MB']

export function sizeLabel(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${String(value)} bytes` : `${value.toFixed(1)} ${UNITS[unit] ?? ''}`
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

const meta = (property: string, content: string) => `<meta property="${property}" content="${escapeHtml(content)}">`

/** Open Graph and Twitter tags: a title always, the rest only when link previews are on. */
function linkTags(name: string, link: LinkPreview): string {
  const tags = [meta('og:type', 'website'), meta('og:site_name', 'Seti'), meta('og:title', name)]
  if (link.url !== null) {
    tags.push(meta('og:url', link.url))
  }
  if (link.description !== null) {
    tags.push(
      meta('og:description', link.description),
      `<meta name="description" content="${escapeHtml(link.description)}">`,
    )
  }
  if (link.image === null) {
    tags.push('<meta name="twitter:card" content="summary">')
    return tags.join('')
  }
  tags.push(
    meta('og:image', link.image),
    meta('og:image:type', 'image/png'),
    meta('og:image:width', String(CARD_WIDTH)),
    meta('og:image:height', String(CARD_HEIGHT)),
    meta('og:image:alt', `${name}, shared from Seti`),
    '<meta name="twitter:card" content="summary_large_image">',
  )
  return tags.join('')
}

/** The whole page of a share: styles inline, no script, nothing loaded from anywhere else. */
export function sharePage(input: SharePageInput): string {
  const name = escapeHtml(input.name)
  const detail = `${sizeLabel(input.size)}, shared from Seti, updated ${when(input.updatedAt)}`
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">',
    `<title>${name}</title>${linkTags(input.name, input.link)}<style>${SHARE_STYLE}</style></head>`,
    '<body><header><div class="meta">',
    `<h1>${name}</h1><div class="sub">${escapeHtml(detail)}</div></div>`,
    `<a class="dl" href="${escapeHtml(input.rawHref)}" download="${name}">Download</a>`,
    `</header><main>${input.body}</main></body></html>`,
  ].join('')
}

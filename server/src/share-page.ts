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

function head(input: Pick<SharePageInput, 'name' | 'link'>, style: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(input.name)}</title>${linkTags(input.name, input.link)}<style>${style}</style></head>`,
  ].join('')
}

/** A lucide icon drawn inline, since the page loads nothing. */
const icon = (paths: string) =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`

const CODE_ICON = icon('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>')

const DOWNLOAD_ICON = icon(
  '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
)

const action = (href: string, label: string, svg: string, extra = '') =>
  `<a class="act" href="${escapeHtml(href)}" aria-label="${label}" title="${label}"${extra}>${svg}</a>`

const download = (input: Pick<SharePageInput, 'name' | 'rawHref'>) =>
  action(input.rawHref, 'Download', DOWNLOAD_ICON, ` download="${escapeHtml(input.name)}"`)

/** One line: the name, its size and date where there is room, Seti's mark and the icon actions. */
function bar(input: Pick<SharePageInput, 'name' | 'size' | 'updatedAt'>, actions: string): string {
  const name = escapeHtml(input.name)
  const detail = escapeHtml(`${sizeLabel(input.size)}, updated ${when(input.updatedAt)}`)
  return [
    `<header><h1 title="${name}&#10;${detail}">${name}</h1><span class="info">${detail}</span>`,
    `<span class="by" title="Shared from Seti">Seti</span><div class="acts">${actions}</div></header>`,
  ].join('')
}

/** The whole page of a share: styles inline, no script, nothing loaded from anywhere else. */
export function sharePage(input: SharePageInput): string {
  return [
    head(input, SHARE_STYLE),
    '<body>',
    bar(input, download(input)),
    `<main>${input.body}</main></body></html>`,
  ].join('')
}

export interface RenderedSharePageInput extends Omit<SharePageInput, 'body'> {
  codeHref: string
  frameHref: string
}

/** The bar stays put and the frame takes the rest; a page without a background shows on white. */
const RENDER_STYLE = `${SHARE_STYLE}
body{display:flex;flex-direction:column;height:100vh;height:100dvh;overflow:hidden}
header{flex:none}
iframe.page{flex:1 1 auto;display:block;width:100%;min-height:0;border:0;background:#fff;color-scheme:light}
`

/** A rendered share's shell: Seti's bar, no script, and the page in a frame with an opaque origin. */
export function renderedSharePage(input: RenderedSharePageInput): string {
  return [
    head(input, RENDER_STYLE),
    '<body>',
    bar(input, `${action(input.codeHref, 'View code', CODE_ICON)}${download(input)}`),
    `<iframe class="page" src="${escapeHtml(input.frameHref)}" sandbox="allow-scripts" referrerpolicy="no-referrer"`,
    ` title="${escapeHtml(input.name)}"></iframe></body></html>`,
  ].join('')
}

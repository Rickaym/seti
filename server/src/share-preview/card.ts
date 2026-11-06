import { extensionOf } from '@seti/shared'
import { dataUri } from './image.js'
import type { PreviewImage } from './preview.js'
import { rasterizeSvg } from './svg.js'

/** The size link previews ask for: Slack, WhatsApp, X, LinkedIn and the rest crop to 1.91:1. */
export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/** Text safe inside an SVG element or attribute; control characters XML forbids are dropped. */
const escapeXml = (text: string) =>
  text.replace(/\p{Cc}/gu, '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char)

const NAME_SIZE = 56
const NAME_LINES = 3
/** DejaVu Sans Bold runs about 0.63 em a character. */
const CHAR_EM = 0.63

/** Breaks a name into at most three lines, at a separator near the end of a line when it can. */
export function nameLines(name: string, perLine: number): string[] {
  const chars = Array.from(name)
  const lines: string[] = []
  while (chars.length > 0 && lines.length < NAME_LINES) {
    if (chars.length <= perLine) {
      lines.push(chars.splice(0).join(''))
      break
    }
    const head = chars.slice(0, perLine)
    const breakAt = Math.max(...['-', '_', '.', ' ', '/'].map((mark) => head.lastIndexOf(mark)))
    const cut = breakAt >= perLine - 10 ? breakAt + 1 : perLine
    lines.push(chars.splice(0, cut).join(''))
  }
  if (chars.length > 0) {
    const last = Array.from(lines.pop() ?? '')
    lines.push(`${last.slice(0, Math.max(1, last.length - 1)).join('')}\u2026`)
  }
  return lines
}

export interface CardInput {
  name: string
  /** The kind and size, such as "PDF, 12 pages, 1.4 MB". */
  detail: string
  thumb: PreviewImage | null
  /** Marks the thumbnail as a video's poster with a play button. */
  play?: boolean
}

const PANEL = { x: 64, y: 64, width: 400, height: 502 }

/** A play button in the middle of the panel, over a video's poster. */
function playButton(): string {
  const [cx, cy] = [PANEL.x + PANEL.width / 2, PANEL.y + PANEL.height / 2]
  const triangle = `${String(cx - 20)},${String(cy - 30)} ${String(cx - 20)},${String(cy + 30)} ${String(cx + 32)},${String(cy)}`
  return `<circle cx="${String(cx)}" cy="${String(cy)}" r="56" fill="#000000" fill-opacity="0.6"/><polygon points="${triangle}" fill="#ffffff"/>`
}

function panel(input: CardInput): string {
  const wide = input.thumb !== null && input.thumb.width > input.thumb.height
  const fill = wide ? '#0d1117' : '#ffffff'
  const frame = `<rect x="${String(PANEL.x)}" y="${String(PANEL.y)}" width="${String(PANEL.width)}" height="${String(PANEL.height)}" rx="16" fill="${fill}" stroke="#d0d7de" stroke-width="2"/>`
  if (input.thumb !== null) {
    const href = dataUri(input.thumb.mime, input.thumb.bytes)
    const fit = wide ? 'xMidYMid meet' : 'xMidYMin slice'
    const image = `<image href="${href}" x="${String(PANEL.x + 2)}" y="${String(PANEL.y + 2)}" width="${String(PANEL.width - 4)}" height="${String(PANEL.height - 4)}" preserveAspectRatio="${fit}" clip-path="url(#panel)"/>`
    return frame + image + (input.play === true ? playButton() : '')
  }
  const extension = extensionOf(input.name)
  const type = escapeXml((extension === '' ? 'file' : extension).toUpperCase().slice(0, 6))
  return `${frame}<text x="${String(PANEL.x + PANEL.width / 2)}" y="${String(PANEL.y + PANEL.height / 2 + 30)}" text-anchor="middle" font-size="88" font-weight="bold" fill="#0969da">${type}</text>`
}

/** The card as an SVG document; every piece of the file's name and label is escaped. */
export function cardSvg(input: CardInput): string {
  const left = PANEL.x + PANEL.width + 56
  const perLine = Math.floor((CARD_WIDTH - left - 64) / (NAME_SIZE * CHAR_EM))
  const lines = nameLines(input.name, perLine)
  const name = lines
    .map(
      (line, n) =>
        `<tspan x="${String(left)}" dy="${n === 0 ? '0' : String(NAME_SIZE * 1.2)}">${escapeXml(line)}</tspan>`,
    )
    .join('')
  const detailY = 200 + (lines.length - 1) * NAME_SIZE * 1.2 + 76
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}" viewBox="0 0 ${String(CARD_WIDTH)} ${String(CARD_HEIGHT)}">`,
    `<defs><clipPath id="panel"><rect x="${String(PANEL.x + 2)}" y="${String(PANEL.y + 2)}" width="${String(PANEL.width - 4)}" height="${String(PANEL.height - 4)}" rx="14"/></clipPath></defs>`,
    `<rect width="${String(CARD_WIDTH)}" height="${String(CARD_HEIGHT)}" fill="#f6f7f9"/>`,
    `<rect width="${String(CARD_WIDTH)}" height="12" fill="#0969da"/>`,
    panel(input),
    `<text x="${String(left)}" y="200" font-family="DejaVu Sans" font-size="${String(NAME_SIZE)}" font-weight="bold" fill="#1f2328">${name}</text>`,
    `<text x="${String(left)}" y="${String(detailY)}" font-family="DejaVu Sans" font-size="32" fill="#57606a">${escapeXml(input.detail)}</text>`,
    `<text x="${String(left)}" y="560" font-family="DejaVu Sans" font-size="28" fill="#57606a">Shared from Seti</text>`,
    '</svg>',
  ].join('')
}

/** The link card as a 1200 by 630 PNG, rendered in the converter sandbox, or why it failed. */
export async function renderCard(input: CardInput): Promise<Buffer | string> {
  const image = await rasterizeSvg(Buffer.from(cardSvg(input)), { width: CARD_WIDTH, height: CARD_HEIGHT })
  return typeof image === 'string' ? image : image.bytes
}

import { converterPath, runConverter, type ConverterLimits } from '../converter.js'
import { escapeHtml } from '../share-markdown.js'
import { rasterSize } from './image.js'
import { LAYER_HTML_MAX, LAYER_INPUT_MAX, parseTextLayer, textLayerHtml, type PageText } from './pdf-text.js'
import {
  capital,
  count,
  converterError,
  imageTag,
  IMAGE_BYTES_MAX,
  noteLine,
  plural,
  type ImageSlots,
  type PreviewImage,
  type RenderedPreview,
} from './preview.js'

const MB = 1024 * 1024
const PAGES_MAX = 50
/** Wide enough to read on a phone at three device pixels a point, and on a desktop column. */
const PAGE_WIDTH = 1200

const INFO_LIMITS: ConverterLimits = {
  timeoutMs: 15_000,
  cpuSeconds: 15,
  memoryBytes: 512 * MB,
  fileBytes: MB,
  outputBytes: MB,
}
const RENDER_LIMITS: ConverterLimits = {
  timeoutMs: 120_000,
  cpuSeconds: 120,
  memoryBytes: 1024 * MB,
  fileBytes: 8 * MB,
  outputBytes: IMAGE_BYTES_MAX,
}
const TEXT_LIMITS: ConverterLimits = {
  timeoutMs: 30_000,
  cpuSeconds: 30,
  memoryBytes: 512 * MB,
  fileBytes: MB,
  outputBytes: LAYER_INPUT_MAX,
}

const INPUT = '/in/input.pdf'

/** Pages go from poppler to ffmpeg as raw pixmaps on a pipe, so no page is ever written raw. */
const TO_WEBP =
  'pdftoppm -scale-to-x "$1" -scale-to-y -1 -f 1 -l "$2" /in/input.pdf | ' +
  'ffmpeg -nostdin -hide_banner -loglevel error -threads 1 -f image2pipe -c:v ppm -i - ' +
  '-c:v libwebp -quality 70 -compression_level 4 /out/p-%03d.webp'

/** Without ffmpeg, poppler writes JPEG itself; larger, but still one file a page. */
const TO_JPEG = 'pdftoppm -jpeg -jpegopt quality=75 -scale-to-x "$1" -scale-to-y -1 -f 1 -l "$2" /in/input.pdf /out/p'

/** What a paged document is called on the page, the card and in errors. */
export interface PagedKind {
  /** The label's head, such as "PDF" or "Word document". */
  name: string
  /** What one page is called, such as "page" or "slide". */
  unit: string
  /** What it is in an error, such as "this PDF". */
  subject: string
}

const PDF: PagedKind = { name: 'PDF', unit: 'page', subject: 'this PDF' }

export interface PdfInfo {
  pages: number
  title: string | null
}

/** Page count and title from pdfinfo's report. */
export function parsePdfInfo(report: string): PdfInfo | null {
  const fields = new Map<string, string>()
  for (const line of report.split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim())
    }
  }
  const pages = fields.get('Pages') ?? ''
  if (!/^\d+$/.test(pages)) {
    return null
  }
  const title = fields.get('Title') ?? ''
  return { pages: Number(pages), title: title === '' ? null : title }
}

const pdf = (bytes: Buffer) => new Map([['input.pdf', bytes]])

async function pageImages(bytes: Buffer, pages: number): Promise<PreviewImage[] | string> {
  const script = converterPath('ffmpeg') === null ? TO_JPEG : TO_WEBP
  const last = String(Math.min(pages, PAGES_MAX))
  const result = await runConverter({
    program: 'sh',
    args: ['-c', script, 'sh', String(PAGE_WIDTH), last],
    inputs: pdf(bytes),
    limits: RENDER_LIMITS,
  })
  if (!result.ok) {
    return result.error
  }
  const images: PreviewImage[] = []
  for (const [name, page] of result.files) {
    const size = rasterSize(page)
    if (size !== null) {
      images.push({ mime: name.endsWith('.webp') ? 'image/webp' : 'image/jpeg', bytes: page, ...size })
    }
  }
  return images.length === 0 ? 'no pages came out' : images
}

/** Each page's text lines and their boxes, read from poppler's XHTML by a strict parser. */
async function pageText(bytes: Buffer, pages: number): Promise<(PageText | null)[]> {
  const last = String(Math.min(pages, PAGES_MAX))
  const result = await runConverter({
    program: 'pdftotext',
    args: ['-bbox-layout', '-f', '1', '-l', last, '-enc', 'UTF-8', INPUT, '-'],
    inputs: pdf(bytes),
    limits: TEXT_LIMITS,
  })
  return result.ok ? parseTextLayer(result.stdout.toString('utf8')) : []
}

function pagesHtml(
  images: readonly PreviewImage[],
  text: readonly (PageText | null)[],
  slots: ImageSlots,
  unit: string,
): { html: string; shown: number } {
  const figures: string[] = []
  const word = capital(unit)
  let budget = LAYER_HTML_MAX
  for (const [n, image] of images.entries()) {
    const src = slots.add(image)
    if (src === null) {
      break
    }
    const page = `${word} ${String(n + 1)}`
    const layer = textLayerHtml(text[n], image)
    budget -= layer.length
    const sheet = `<div class="sheet">${imageTag(src, image, page, 'page')}${budget < 0 ? '' : layer}</div>`
    figures.push(`<figure class="page">${sheet}<figcaption>${page}</figcaption></figure>`)
  }
  return { html: `<div class="pages">${figures.join('')}</div>`, shown: figures.length }
}

/** A PDF as page images under selectable text, made by poppler inside the converter sandbox. */
export async function pdfPreview(bytes: Buffer, slots: ImageSlots, kind: PagedKind = PDF): Promise<RenderedPreview> {
  const info = await runConverter({
    program: 'pdfinfo',
    args: ['-enc', 'UTF-8', INPUT],
    inputs: pdf(bytes),
    limits: INFO_LIMITS,
  })
  const parsed = info.ok ? parsePdfInfo(info.stdout.toString('utf8')) : null
  if (parsed === null || parsed.pages < 1) {
    const error = converterError(capital(kind.subject), info.ok ? `it has no ${kind.unit}s` : info.error)
    return { body: '', label: kind.name, note: null, error, thumb: null }
  }
  const label = `${kind.name}, ${plural(parsed.pages, kind.unit)}`
  const [images, text] = [await pageImages(bytes, parsed.pages), await pageText(bytes, parsed.pages)]
  const pages = typeof images === 'string' ? { html: '', shown: 0 } : pagesHtml(images, text, slots, kind.unit)
  const note =
    pages.shown < parsed.pages ? `first ${count(pages.shown)} of ${plural(parsed.pages, kind.unit)} shown` : null
  const title = parsed.title === null ? '' : `<p class="caption"><b>${escapeHtml(parsed.title)}</b></p>`
  const caption = note === null ? `<p class="caption">${escapeHtml(label)}</p>` : noteLine(note)
  return {
    body: title + caption + pages.html,
    label,
    note,
    error: typeof images === 'string' ? converterError(`The ${kind.unit}s of ${kind.subject}`, images) : null,
    thumb: typeof images === 'string' ? null : (images[0] ?? null),
  }
}

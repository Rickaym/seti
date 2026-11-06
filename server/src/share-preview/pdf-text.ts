import { z } from 'zod'
import { escapeHtml } from '../share-markdown.js'

/** Which way a line reads on the page: across, or turned to read downwards or upwards. */
type Run = 'across' | 'down' | 'up'

/** One line of a page's text, its box in points from the page's top left corner. */
interface TextLine {
  x: number
  y: number
  width: number
  height: number
  text: string
  run: Run
}

/** A page's text lines with the page size pdftotext reports, before any rotation. */
export interface PageText {
  width: number
  height: number
  lines: TextLine[]
}

/** The converter prints at most this much; the parser reads no further. */
export const LAYER_INPUT_MAX = 16 * 1024 * 1024
/** The text layers of all pages together, inside the 4 MB page cap; later pages go without. */
export const LAYER_HTML_MAX = 3 * 1024 * 1024
const PAGES_MAX = 50
const LINES_MAX = 4000
const WORDS_MAX = 1000
const CHARS_MAX = 2000
const SIDE_MAX = 100_000
/** The advance of a monospace glyph in em, near enough for every common monospace font. */
const ADVANCE = 0.6
/** How far a page's shape may differ from its image's before the layer is left off. */
const ASPECT_SLACK = 0.02

const decimal = z
  .string()
  .regex(/^-?\d{1,9}(?:\.\d{1,9})?$/)
  .transform(Number)
const side = decimal.pipe(z.number().positive().max(SIDE_MAX))
const coordinate = decimal.pipe(z.number().min(-SIDE_MAX).max(SIDE_MAX))
const boxSchema = z
  .object({ xMin: coordinate, yMin: coordinate, xMax: coordinate, yMax: coordinate })
  .refine((box) => box.xMax > box.xMin && box.yMax > box.yMin)
const sizeSchema = z.object({ width: side, height: side })

type Box = z.infer<typeof boxSchema>
type Groups = Record<string, string | undefined>

interface DraftLine {
  box: Box | null
  words: { box: Box; text: string }[]
}

interface DraftPage {
  size: { width: number; height: number } | null
  lines: DraftLine[]
}

const BOX = (tag: string) =>
  `xMin="(?<${tag}x0>[^"<>]*)" yMin="(?<${tag}y0>[^"<>]*)" xMax="(?<${tag}x1>[^"<>]*)" yMax="(?<${tag}y1>[^"<>]*)">`

/** The only tags read; blocks, flows and anything else pdftotext prints are skipped. */
const TOKEN = new RegExp(
  `<page width="(?<pw>[^"<>]*)" height="(?<ph>[^"<>]*)">|<line ${BOX('l')}|<word ${BOX('w')}(?<text>[^<>]*)</word>`,
  'g',
)

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (all, name: string) => ENTITIES[name] ?? all)

function readBox(groups: Groups, tag: string): Box | null {
  const parsed = boxSchema.safeParse({
    xMin: groups[`${tag}x0`],
    yMin: groups[`${tag}y0`],
    xMax: groups[`${tag}x1`],
    yMax: groups[`${tag}y1`],
  })
  return parsed.success ? parsed.data : null
}

function readSize(width: string, height: string): DraftPage['size'] {
  const parsed = sizeSchema.safeParse({ width, height })
  return parsed.success ? parsed.data : null
}

function addWord(line: DraftLine | undefined, groups: Groups, text: string): void {
  const box = readBox(groups, 'w')
  if (line !== undefined && box !== null && line.words.length < WORDS_MAX) {
    line.words.push({ box, text: decode(text) })
  }
}

/** Adds one token to the pages read so far; false once the page cap is reached. */
function addToken(pages: DraftPage[], groups: Groups): boolean {
  const page = pages.at(-1)
  if (groups.pw !== undefined && groups.ph !== undefined) {
    if (pages.length === PAGES_MAX) {
      return false
    }
    pages.push({ size: readSize(groups.pw, groups.ph), lines: [] })
  } else if (groups.lx0 !== undefined && page !== undefined && page.lines.length < LINES_MAX) {
    page.lines.push({ box: readBox(groups, 'l'), words: [] })
  } else if (groups.text !== undefined) {
    addWord(page?.lines.at(-1), groups, groups.text)
  }
  return true
}

/** Pages, lines and words in the order pdftotext printed them, numbers checked, nothing else. */
function tokenize(xhtml: string): DraftPage[] {
  const pages: DraftPage[] = []
  for (const match of xhtml.slice(0, LAYER_INPUT_MAX).matchAll(TOKEN)) {
    if (!addToken(pages, match.groups ?? {})) {
      break
    }
  }
  return pages
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** The characters a reader sees, each one cell of a monospace font. */
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment)

/** Words that step down or up the page rather than across it make a turned line. */
function runOf(line: DraftLine, box: Box): Run {
  const first = line.words.at(0)
  const last = line.words.at(-1)
  if (first === undefined || last === undefined) {
    return 'across'
  }
  if (first !== last) {
    const along = last.box.yMin - first.box.yMin
    if (Math.abs(along) <= Math.abs(last.box.xMin - first.box.xMin)) {
      return 'across'
    }
    return along > 0 ? 'down' : 'up'
  }
  const tall = box.yMax - box.yMin > 1.5 * (box.xMax - box.xMin)
  return tall && graphemes(first.text).length >= 4 ? 'down' : 'across'
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

// eslint-disable-next-line no-control-regex -- control characters never belong in the layer
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** The line cut to the page, or null when nothing of it is on the page. */
function clip(line: TextLine, width: number, height: number): TextLine | null {
  const x = clamp(line.x, 0, width)
  const y = clamp(line.y, 0, height)
  const w = clamp(line.x + line.width, 0, width) - x
  const h = clamp(line.y + line.height, 0, height) - y
  return w > 0 && h > 0 ? { ...line, x, y, width: w, height: h } : null
}

/** A turned page's boxes are in its turned frame, so lines are cut to its longer side here. */
function toLine(line: DraftLine, bound: number): TextLine | null {
  if (line.box === null) {
    return null
  }
  const joined = line.words.map((word) => word.text).join(' ')
  const text = graphemes(joined.slice(0, 8 * CHARS_MAX).replace(CONTROL, ''))
    .slice(0, CHARS_MAX)
    .join('')
  if (text.trim() === '') {
    return null
  }
  const { xMin, yMin, xMax, yMax } = line.box
  const box = { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin }
  return clip({ ...box, text, run: runOf(line, line.box) }, bound, bound)
}

/**
 * Text lines from `pdftotext -bbox-layout`, one entry a page in order. That output is untrusted:
 * only page, line and word tags are read, every number is checked, and text is decoded once.
 * A page whose size does not parse is null, so later pages keep their numbers.
 */
export function parseTextLayer(xhtml: string): (PageText | null)[] {
  return tokenize(xhtml).map(({ size, lines }) => {
    if (size === null) {
      return null
    }
    const kept: TextLine[] = []
    for (const line of lines) {
      const parsed = toLine(line, Math.max(size.width, size.height))
      if (parsed !== null) {
        kept.push(parsed)
      }
    }
    return { ...size, lines: kept }
  })
}

const near = (a: number, b: number) => Math.abs(a - b) <= ASPECT_SLACK * b

/** The page size as shown: pdftotext reports a turned page unturned, with its boxes turned. */
function shownSize(page: PageText, image: { width: number; height: number }) {
  const shape = image.width / image.height
  if (near(page.width / page.height, shape)) {
    return { width: page.width, height: page.height }
  }
  return near(page.height / page.width, shape) ? { width: page.height, height: page.width } : null
}

const num = (value: number) => String(Math.round(value * 1000) / 1000)

const TURN: Readonly<Record<Run, string>> = { across: '', down: 'rotate(90deg) ', up: 'rotate(-90deg) ' }

function lineHtml(line: TextLine, width: number, height: number): string {
  const across = line.run === 'across'
  const thick = across ? line.height : line.width
  const long = across ? line.width : line.height
  const left = line.run === 'down' ? line.x + line.width : line.x
  const top = line.run === 'up' ? line.y + line.height : line.y
  const scale = clamp(long / (ADVANCE * thick * graphemes(line.text).length), 0.01, 100)
  const style =
    `left:${num((left / width) * 100)}%;top:${num((top / height) * 100)}%;` +
    `font-size:${num((thick / width) * 100)}cqw;transform:${TURN[line.run]}scaleX(${num(scale)})`
  return `<span style="${style}">${escapeHtml(line.text)}</span>`
}

/**
 * A page's text as transparent, selectable lines over its image, placed in percentages of the
 * page so they scale with it. Empty when the page has no text or its shape is not the image's.
 */
export function textLayerHtml(page: PageText | null | undefined, image: { width: number; height: number }): string {
  if (page === null || page === undefined || page.lines.length === 0 || image.width <= 0 || image.height <= 0) {
    return ''
  }
  const size = shownSize(page, image)
  if (size === null) {
    return ''
  }
  const lines: string[] = []
  for (const line of page.lines) {
    const shown = clip(line, size.width, size.height)
    if (shown !== null) {
      lines.push(lineHtml(shown, size.width, size.height))
    }
  }
  return lines.length === 0 ? '' : `<div class="tl">${lines.join('<br>')}</div>`
}

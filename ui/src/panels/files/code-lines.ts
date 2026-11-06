import { HIGHLIGHT_LINE_MAX, longestLine } from '@seti/shared'

/** Files over this size show as plain text, so the viewer stays fast. */
const FILE_HIGHLIGHT_BYTES = 1_000_000
/** Files over this many lines show as plain text, so the viewer stays fast. */
export const FILE_HIGHLIGHT_LINES = 20_000
/** Lines per chunk, the unit the viewer colours as it scrolls. */
const CHUNK_LINES = 200
/** A chunk ends early once it holds this many characters, so no chunk colours too much at once. */
const CHUNK_CHARS = 20_000

/** A run of lines: the number of its first line, how many it holds, and its offsets in the text. */
export interface LineChunk {
  first: number
  count: number
  from: number
  to: number
}

/** A stretch of a chunk, which is the marked line or text around it. */
export interface LinePiece {
  from: number
  to: number
  marked: boolean
}

/** Where each line starts; a final newline ends the last line rather than starting another. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1 && at + 1 < text.length; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1)
  }
  return starts
}

/** How many lines the text holds, as an editor numbers them. */
export const lineCount = (text: string) => lineStarts(text).length

/** Why the viewer shows text plain: too big a file, or a line too long to colour. */
export type PlainReason = 'size' | 'long-line'

/** The reason the text stays plain in the viewer, or null when it is small enough to colour. */
export function plainReason(text: string): PlainReason | null {
  if (text.length > FILE_HIGHLIGHT_BYTES || lineCount(text) > FILE_HIGHLIGHT_LINES) {
    return 'size'
  }
  return longestLine(text) > HIGHLIGHT_LINE_MAX ? 'long-line' : null
}

/** How many lines from `index` on make a chunk: up to CHUNK_LINES, fewer past CHUNK_CHARS. */
function chunkLength(starts: readonly number[], index: number): number {
  const from = starts[index] ?? 0
  let count = 1
  while (count < CHUNK_LINES && index + count < starts.length && (starts[index + count] ?? 0) - from < CHUNK_CHARS) {
    count++
  }
  return count
}

/** The text in chunks of whole lines, each ending before the newline that follows it. */
export function chunksOf(text: string): LineChunk[] {
  const starts = lineStarts(text)
  const textEnd = text.endsWith('\n') ? text.length - 1 : text.length
  const chunks: LineChunk[] = []
  let index = 0
  while (index < starts.length) {
    const count = chunkLength(starts, index)
    const next = starts[index + count]
    chunks.push({ first: index + 1, count, from: starts[index] ?? 0, to: next === undefined ? textEnd : next - 1 })
    index += count
  }
  return chunks
}

/** A chunk split around its marked line, or whole when the line is elsewhere. */
export function piecesOf(text: string, chunk: LineChunk, line: number | undefined): LinePiece[] {
  if (line === undefined || line < chunk.first || line >= chunk.first + chunk.count) {
    return [{ from: chunk.from, to: chunk.to, marked: false }]
  }
  let start = chunk.from
  for (let n = chunk.first; n < line; n++) {
    start = text.indexOf('\n', start) + 1
  }
  const newline = text.indexOf('\n', start)
  const end = newline === -1 || newline > chunk.to ? chunk.to : newline
  const pieces: LinePiece[] = [
    { from: chunk.from, to: start, marked: false },
    { from: start, to: end, marked: true },
    { from: end, to: chunk.to, marked: false },
  ]
  return pieces.filter((piece) => piece.marked || piece.to > piece.from)
}

import { HIGHLIGHT_LINE_MAX, longestLine, type CodeLanguage } from '@seti/shared'
import { highlight, type Segment } from '@seti/shared/highlight'
import { escapeHtml } from '../share-markdown.js'
import { count, plural } from './preview.js'

/** Larger code shows as plain numbered text, so one file never holds the server for long. */
export const HIGHLIGHT_MAX = 512 * 1024
/** Lines a text page shows; past them the page says how many it left out. */
export const LINES_MAX = 20_000
/** Characters a text page shows, whatever its line count. */
const TEXT_CHARS_MAX = 2 * 1024 * 1024

interface Lines {
  shown: Segment[][]
  total: number
}

/** Splits runs into lines, so each line is its own element and wraps or scrolls on its own. */
function splitLines(segments: readonly Segment[], limit: number): Lines {
  const lines: Segment[][] = [[]]
  let total = 1
  for (const segment of segments) {
    const parts = segment.text.split('\n')
    for (const [n, part] of parts.entries()) {
      if (n > 0) {
        total += 1
        if (lines.length < limit) {
          lines.push([])
        }
      }
      if (part !== '' && total <= limit) {
        lines.at(-1)?.push({ text: part, className: segment.className })
      }
    }
  }
  return { shown: lines, total }
}

const lineHtml = (line: readonly Segment[]) =>
  line
    .map((run) =>
      run.className === '' ? escapeHtml(run.text) : `<span class="${run.className}">${escapeHtml(run.text)}</span>`,
    )
    .join('')

/** Numbered lines; the numbers come from CSS counters, so copying the text leaves them out. */
function numbered(lines: Lines, wrap: boolean): string {
  const gutter = String(Math.max(2, String(lines.shown.length).length) + 2)
  const body = lines.shown.map((line) => `<span class="l">${lineHtml(line)}</span>`).join('')
  return `<pre class="code${wrap ? ' wrap' : ''}" style="--gut:${gutter}ch"><code>${body}</code></pre>`
}

/** The first characters of a text, cut at a line end when one is near. */
function clip(text: string): { text: string; clipped: boolean } {
  if (text.length <= TEXT_CHARS_MAX) {
    return { text, clipped: false }
  }
  const cut = text.lastIndexOf('\n', TEXT_CHARS_MAX)
  return { text: text.slice(0, cut > 0 ? cut : TEXT_CHARS_MAX), clipped: true }
}

const lineCount = (text: string) => {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    lines += 1
  }
  return lines
}

export interface NumberedText {
  html: string
  lines: number
  /** "first 20,000 lines shown", when the page leaves lines out. */
  note: string | null
}

/** Text with line numbers, highlighted when it has a language and is small enough. */
export async function numberedText(text: string, language: CodeLanguage | null, wrap: boolean): Promise<NumberedText> {
  const whole = text.endsWith('\n') ? text.slice(0, -1) : text
  const total = lineCount(whole)
  const { text: kept, clipped } = clip(whole)
  const colour = language !== null && kept.length <= HIGHLIGHT_MAX && longestLine(kept) <= HIGHLIGHT_LINE_MAX
  const segments = colour ? await highlight(kept, language) : [{ text: kept, className: '' }]
  const lines = splitLines(segments, LINES_MAX)
  const shown = lines.shown.length
  return {
    html: numbered(lines, wrap),
    lines: total,
    note: clipped || total > shown ? `first ${count(shown)} of ${plural(total, 'line')} shown` : null,
  }
}

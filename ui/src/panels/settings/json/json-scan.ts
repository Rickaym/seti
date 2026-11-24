/** One open object or array while scanning JSON text, with the key its next value goes under. */
interface Frame {
  kind: 'object' | 'array'
  /** In an object: the key just read, or null while a key is expected. */
  key: string | null
  /** In an array: the index of the next value. */
  index: number
}

/** Where a key sits in the text, by the path of the value it names. */
export interface KeySpan {
  path: string[]
  from: number
  to: number
}

/** What the caret is in the middle of: a key of the object at `path`, or the value at `path`. */
export interface JsonContext {
  kind: 'key' | 'value'
  path: string[]
  /** Where the word being typed starts, quote included. */
  from: number
}

const pathOf = (stack: readonly Frame[]) =>
  stack.flatMap((frame) => {
    if (frame.kind === 'array') {
      return [String(frame.index)]
    }
    return frame.key === null ? [] : [frame.key]
  })

/** The end of the string that starts at `start` (its opening quote), or -1 when it is open. */
function stringEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '"') {
      return i
    }
    i += text[i] === '\\' ? 2 : 1
  }
  return -1
}

const decoded = (raw: string): string => {
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char)

const nextNonSpace = (text: string, from: number) => {
  let i = from
  while (isSpace(text[i])) {
    i += 1
  }
  return i
}

/** Reads JSON text, which may be half typed, keeping open objects and the keys it has seen. */
class Scanner {
  readonly stack: Frame[] = []
  readonly keys: KeySpan[] = []
  /** The last character that was not space or inside a value, such as `{`, `,` or `:`. */
  mark = ''

  constructor(private readonly text: string) {}

  run(end: number): this {
    let i = 0
    while (i < end) {
      const char = this.text[i] ?? ''
      if (char === '"') {
        i = this.string(i)
      } else if ('{}[],:'.includes(char)) {
        this.punctuation(char)
      } else if (!isSpace(char)) {
        this.mark = 'v'
      }
      i += 1
    }
    return this
  }

  private closeValue(): void {
    const top = this.stack.at(-1)
    if (top?.kind === 'object') {
      top.key = null
    }
  }

  private string(start: number): number {
    const end = stringEnd(this.text, start)
    const stop = end === -1 ? this.text.length : end
    const top = this.stack.at(-1)
    if (top?.kind === 'object' && top.key === null && this.text[nextNonSpace(this.text, stop + 1)] === ':') {
      top.key = decoded(this.text.slice(start, stop + 1))
      this.keys.push({ path: pathOf(this.stack), from: start, to: stop + 1 })
    }
    this.mark = '"'
    return stop
  }

  private punctuation(char: string): void {
    if (char === '{' || char === '[') {
      this.stack.push({ kind: char === '{' ? 'object' : 'array', key: null, index: 0 })
    } else if (char === '}' || char === ']') {
      this.stack.pop()
      this.closeValue()
    } else if (char === ',') {
      const top = this.stack.at(-1)
      if (top?.kind === 'array') {
        top.index += 1
      }
      this.closeValue()
    }
    this.mark = char
  }
}

const scan = (text: string, end = text.length) => new Scanner(text).run(end)

/** Every key in the text with its path, to place a server error on its line. */
export const keySpans = (text: string): KeySpan[] => scan(text).keys

/** Where the string the text ends inside starts, or null when it ends outside any string. */
function openString(text: string): number | null {
  let i = text.indexOf('"')
  while (i !== -1) {
    const end = stringEnd(text, i)
    if (end === -1) {
      return i
    }
    i = text.indexOf('"', end + 1)
  }
  return null
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\w.-]/.test(char)

/** Where the bare word the text ends with starts, such as `tru` of a value being typed. */
function wordStartOf(text: string): number {
  let i = text.length
  while (isWordChar(text[i - 1])) {
    i -= 1
  }
  return i
}

/** The caret's context in half typed JSON, for completion; null outside any object. */
export function contextAt(text: string, pos: number): JsonContext | null {
  const before = text.slice(0, pos)
  const quote = openString(before)
  const wordStart = quote ?? wordStartOf(before)
  const state = scan(text, wordStart)
  const top = state.stack.at(-1)
  if (top === undefined) {
    return null
  }
  if (top.kind === 'object' && (top.key === null || state.mark !== ':')) {
    const path = pathOf(state.stack)
    return { kind: 'key', path: top.key === null ? path : path.slice(0, -1), from: wordStart }
  }
  return { kind: 'value', path: pathOf(state.stack), from: wordStart }
}

/** The line, from 1, of a path's key in the text, or of the nearest key above it. */
export function lineOfPath(text: string, path: readonly string[]): number | null {
  const spans = keySpans(text)
  for (let depth = path.length; depth > 0; depth -= 1) {
    const want = path.slice(0, depth).join('\u0000')
    const span = spans.find((key) => key.path.join('\u0000') === want)
    if (span !== undefined) {
      return text.slice(0, span.from).split('\n').length
    }
  }
  return null
}

/** Where a JSON.parse error points, as a line from 1, when its message says. */
export function parseErrorLine(text: string, message: string): number | null {
  const line = /line (\d+)/.exec(message)?.[1]
  if (line !== undefined) {
    return Number(line)
  }
  const position = Number(/position (\d+)/.exec(message)?.[1] ?? Number.NaN)
  return Number.isNaN(position) ? null : text.slice(0, position).split('\n').length
}

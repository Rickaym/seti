import type { SourceKind } from '@seti/shared'

/**
 * One citable item an adapter found in a tool result. Its text stays in the transcript: `spans`
 * locate it in the result text (see `locate`), so the ledger keeps no copy.
 */
export interface FoundItem {
  kind: SourceKind
  /** Channel id, `owner/repo`, team key or `owner/repo` of a file. */
  container: string
  /** The key a cited URL is matched by, from `refOfUrl` in `refs.ts`. */
  ref: string
  /** Empty when the adapter cannot build it from parts the source stated. */
  permalink: string
  at: string | null
  spans: string[]
}

/**
 * Reads the items in a call's result text; `workspace` is what the agent's answers from that
 * source stated: the Slack workspace host, or the Linear workspace URL key, when known.
 */
export type ParseResult = (text: string, workspace: string | null) => FoundItem[]

/** Reads the items in a call's result that are placed in the agent's folders, as they stand now. */
export type FolderRead = (taskId: string, text: string) => Promise<FoundItem[]>

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const stringAt = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/** An ISO time when the text is one, else null. */
export function isoTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** A JSON pointer token for a key or index. */
const token = (part: string | number) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')

/** A locator for the string at `path` in the result's JSON, or a range of it. */
export function at(path: readonly (string | number)[], range?: readonly [number, number]): string {
  const pointer = path.map((part) => `/${token(part)}`).join('')
  return range === undefined ? pointer : `${pointer}@${String(range[0])}:${String(range[1])}`
}

function follow(value: unknown, pointer: string): unknown {
  if (pointer === '') {
    return value
  }
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      current = current[Number(key)]
    } else if (isRecord(current)) {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

const RANGE = /@(\d+):(\d+)$/

/** The locator of a whole result shown as numbered lines, read without the numbers. */
export const NUMBERED = '~numbered'

const LINE_NUMBER = /^\s*\d{1,9}[\t\u2192]/

/** Numbered lines without their numbers; null when no line is numbered. */
function unnumbered(text: string): string | null {
  const lines = text.split('\n')
  return lines.some((line) => LINE_NUMBER.test(line))
    ? lines.map((line) => line.replace(LINE_NUMBER, '')).join('\n')
    : null
}

/** The first and last line numbers a numbered result shows, or null when it shows none. */
export function shownLines(text: string): [number, number] | null {
  const numbers = text.split('\n').flatMap((line) => {
    const found = /^\s*(\d{1,9})[\t\u2192]/.exec(line)?.[1]
    return found === undefined ? [] : [Number(found)]
  })
  const [first] = numbers
  const last = numbers.at(-1)
  return first === undefined || last === undefined || last < first ? null : [first, last]
}

/** The text one locator names in a result text; null when it names nothing there any more. */
function locate(text: string, locator: string): string | null {
  if (locator === NUMBERED) {
    return unnumbered(text)
  }
  const range = RANGE.exec(locator)
  const pointer = range === null ? locator : locator.slice(0, range.index)
  const value = pointer === '' ? text : follow(parseJson(text), pointer)
  if (typeof value !== 'string') {
    return null
  }
  if (range === null) {
    return value
  }
  const [start, end] = [Number(range[1]), Number(range[2])]
  return end <= value.length && start <= end ? value.slice(start, end) : null
}

/** An item's text: its spans joined, or null when none resolves. */
export function itemText(text: string, spans: readonly string[]): string | null {
  const parts = spans.flatMap((span) => locate(text, span) ?? [])
  return parts.length === 0 ? null : parts.join('\n\n')
}

import type { ToolCall } from '@seti/shared'
import type { GhApi, GhRead, GhView } from './gh-command.js'
import { ghLine } from './gh-line.js'
import { at, isoTime, isRecord, parseJson, stringAt, type FoundItem, type ParseResult } from './item.js'
import { refOfUrl } from './refs.js'

type Path = readonly (string | number)[]

/** A URL GitHub states for an item, read into its repository, number and comment anchor. */
interface Named {
  repo: string
  number: string
  ref: string
  url: string
}

const HTML = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d{1,9})(?:#[\w-]+)?$/

function named(url: string | null): Named | null {
  const match = url === null ? null : HTML.exec(url)
  const ref = url === null ? undefined : refOfUrl(url)?.ref
  if (match === null || url === null || ref === undefined) {
    return null
  }
  return { repo: match[1] ?? '', number: match[2] ?? '', ref, url }
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const textSpans = (record: Record<string, unknown>, path: Path, keys: readonly string[]) =>
  keys.flatMap((key) => (typeof record[key] === 'string' ? [at([...path, key])] : []))

function found(item: Named, spans: string[], time: string | null): FoundItem[] {
  return spans.length === 0
    ? []
    : [{ kind: 'github', container: item.repo, ref: item.ref, permalink: item.url, at: time, spans }]
}

/** The page of an item gh viewed by number in a repository it named, as GitHub serves it. */
function builtUrl(read: GhView, number: string | null): string | null {
  if (read.repo === null || number === null) {
    return null
  }
  return `https://github.com/${read.repo}/${read.what === 'pr' ? 'pull' : 'issues'}/${number}`
}

const numberOf = (read: GhView): string | null => (read.item !== null && /^\d+$/.test(read.item) ? read.item : null)

/** A view's own URL when it states one for the item asked for, else one built from the call. */
function viewItem(read: GhView, stated: string | null, number: string | null): Named | null {
  const asked = numberOf(read)
  const item = named(stated) ?? named(builtUrl(read, number ?? asked))
  const repoFits = read.repo === null || (item !== null && sameRepo(item.repo, read.repo))
  const numberFits = asked === null || item?.number === asked
  const urlFits = read.item === null || asked !== null || item?.url === read.item
  return item !== null && repoFits && numberFits && urlFits ? item : null
}

/** The `key:\tvalue` lines gh prints before the body when its output is not a terminal. */
function header(text: string): Map<string, string> {
  const lines = text.split('\n')
  const end = lines.indexOf('--')
  return new Map(
    lines.slice(0, end < 0 ? 0 : end).flatMap((line) => {
      const tab = line.indexOf(':\t')
      return tab > 0 ? [[line.slice(0, tab), line.slice(tab + 2)] as const] : []
    }),
  )
}

function viewText(read: GhView, text: string): FoundItem[] {
  const fields = read.comments ? new Map<string, string>() : header(text)
  const item = viewItem(read, fields.get('url') ?? null, fields.get('number') ?? null)
  return item === null ? [] : found(item, [at([])], null)
}

/** A viewed item as JSON: title, body, reviews and unlinked comments; linked comments apart. */
function viewJson(read: GhView, text: string): FoundItem[] {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) {
    return []
  }
  const number = typeof parsed.number === 'number' ? String(parsed.number) : null
  const item = viewItem(read, stringAt(parsed, 'url'), number)
  if (item === null) {
    return []
  }
  const comments = Array.isArray(parsed.comments) ? parsed.comments : []
  const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : []
  const linked = comments.flatMap((comment: unknown, i) => {
    const own = isRecord(comment) ? named(stringAt(comment, 'url')) : null
    const fits = own !== null && own.ref !== item.ref && sameRepo(own.repo, item.repo) && own.number === item.number
    return fits && isRecord(comment) ? [{ i, own, time: isoTime(stringAt(comment, 'createdAt')) }] : []
  })
  const apart = new Set(linked.map(({ i }) => i))
  const spans = [
    ...textSpans(parsed, [], ['title', 'body']),
    ...comments.flatMap((comment: unknown, i) =>
      apart.has(i) || !isRecord(comment) ? [] : textSpans(comment, ['comments', i], ['body']),
    ),
    ...reviews.flatMap((review: unknown, i) => (isRecord(review) ? textSpans(review, ['reviews', i], ['body']) : [])),
  ]
  const time = isoTime(stringAt(parsed, 'createdAt'))
  return [
    ...found(item, spans, time),
    ...linked.flatMap(({ i, own, time: when }) => found(own, [at(['comments', i, 'body'])], when)),
  ]
}

/** One object of a REST answer, kept only when its `html_url` belongs to what the path asked for. */
function restObject(read: GhApi, value: unknown, path: Path): FoundItem[] {
  const record = isRecord(value) ? value : {}
  const item = named(stringAt(record, 'html_url'))
  if (item === null) {
    return []
  }
  const anchored = item.ref.slice(item.ref.indexOf('#')).includes('/')
  const fits =
    sameRepo(item.repo, read.repo) &&
    (read.number === null || item.number === read.number) &&
    anchored === (read.shape !== 'item')
  if (!fits) {
    return []
  }
  const time = isoTime(stringAt(record, 'created_at') ?? stringAt(record, 'submitted_at'))
  return found(item, textSpans(record, path, read.shape === 'item' ? ['title', 'body'] : ['body']), time)
}

function restAnswer(read: GhApi): ParseResult {
  return (text) => {
    const parsed = parseJson(text)
    if (read.shape === 'list') {
      return Array.isArray(parsed) ? parsed.flatMap((value: unknown, i) => restObject(read, value, [i])) : []
    }
    return restObject(read, parsed, [])
  }
}

/** The page of the item a read names by its own words, or null when its words do not say. */
function pageOf(read: GhRead): string | null {
  if (read.form === 'api') {
    const page = read.pull ? 'pull' : 'issues'
    return read.number === null ? null : `https://github.com/${read.repo}/${page}/${read.number}`
  }
  if (read.item === null || numberOf(read) !== null) {
    return builtUrl(read, numberOf(read))
  }
  const item = named(read.item)
  return item !== null && (read.repo === null || sameRepo(item.repo, read.repo)) ? item.url : null
}

/** The item a read names, under the given spans; a diff links to the changed files. */
function identity(read: GhRead, spans: string[]): FoundItem[] {
  const item = named(pageOf(read))
  if (item === null) {
    return []
  }
  const permalink = read.form === 'diff' ? `${item.url}/files` : item.url
  return [{ kind: 'github', container: item.repo, ref: item.ref, permalink, at: null, spans }]
}

/** An error gh prints in place of an answer, so the item was not read. */
const FAILED =
  /^(?:GraphQL: |HTTP \d{3}|gh: |no (?:pull requests?|issues?) found|could not |error|failed |unknown (?:flag|command))/im

/** The reader of a whole, unfiltered answer, which takes items and comments from the JSON. */
function wholeReader(read: GhRead): ParseResult | null {
  if (read.form === 'api') {
    return read.filter === 'none' ? restAnswer(read) : null
  }
  if (read.form === 'diff' || read.filter !== 'none') {
    return null
  }
  return read.json ? (text) => viewJson(read, text) : (text) => viewText(read, text)
}

/**
 * The reader of the GitHub reads a shell line makes with gh, or null for any other call. A whole
 * answer is read as gh prints it; filtered output is recorded under the item the call's words
 * name, its text quotable only when nothing else and nothing that adds text printed into it.
 */
export function githubRead(call: ToolCall): ParseResult | null {
  const command = call.shell?.action === 'run' ? call.shell.command : undefined
  const line = command === undefined ? null : ghLine(command)
  const [only, ...more] = line?.reads ?? []
  if (line === null || only === undefined) {
    return null
  }
  const whole = line.output === 'whole' ? wholeReader(only) : null
  if (whole !== null) {
    return whole
  }
  const quotable = more.length === 0 && line.output !== 'mixed' && only.filter !== 'any'
  const spans = quotable ? [at([])] : []
  return (text) => (text.trim() === '' || FAILED.test(text) ? [] : line.reads.flatMap((read) => identity(read, spans)))
}

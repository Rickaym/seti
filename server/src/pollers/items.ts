import { createHash } from 'node:crypto'
import { normalizeEventKind, POLLER_LIMITS, type PollerItem } from '@seti/shared'

/** What a run returned, once Seti checked it: usable items, why others were left out, the state. */
export interface ReadOutput {
  items: PollerItem[]
  invalid: string[]
  /** False when items were left out or unusable, so keys missing from the run need not be gone. */
  complete: boolean
  /** Undefined keeps the stored state. */
  state: unknown
}

const TEXT_MAX = { key: 200, title: 200, body: 2000, url: 2000, field: 200 } as const
const SHOWN_FIELDS = 30
const INVALID_SHOWN = 20

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON with object keys sorted, so equal values always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort((a, b) => a.localeCompare(b, 'en'))
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The scalar fields an event shows; nested values still count toward the fingerprint. */
function shownFields(fields: Record<string, unknown>): Record<string, unknown> {
  const shown: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (Object.keys(shown).length >= SHOWN_FIELDS) {
      break
    }
    if (typeof value === 'string') {
      shown[name] = clip(value, TEXT_MAX.field)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      shown[name] = value
    }
  }
  return shown
}

const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const firstText = (...values: unknown[]) => values.map(textOf).find((text) => text !== '') ?? ''

function fingerprintOf(raw: Record<string, unknown>, fields: Record<string, unknown>, chosen: readonly string[]) {
  if (typeof raw.fingerprint === 'string' && raw.fingerprint !== '') {
    return clip(raw.fingerprint, TEXT_MAX.key)
  }
  if (chosen.length > 0) {
    return sha256(canonicalJson(chosen.map((name) => fields[name] ?? raw[name] ?? null)))
  }
  const { title, kind, url, body, summary } = raw
  return sha256(canonicalJson({ title, kind, url, body, summary, fields }))
}

type Read = { item: PollerItem } | { problem: string }

function readItem(raw: unknown, fingerprintFields: readonly string[]): Read {
  if (!isRecord(raw)) {
    return { problem: 'not an object' }
  }
  const key = typeof raw.key === 'number' ? String(raw.key) : textOf(raw.key)
  if (key === '') {
    return { problem: 'no key' }
  }
  if (key.length > TEXT_MAX.key) {
    return { problem: `key over ${String(TEXT_MAX.key)} characters` }
  }
  const fields = isRecord(raw.fields) ? raw.fields : {}
  const url = textOf(raw.url)
  const safeUrl = URL.canParse(url) && /^https?:$/.test(new URL(url).protocol) ? clip(url, TEXT_MAX.url) : null
  const item: PollerItem = {
    key,
    title: clip(firstText(raw.title, key), TEXT_MAX.title),
    kind: normalizeEventKind(textOf(raw.kind)),
    url: safeUrl,
    body: clip(firstText(raw.body, raw.summary), TEXT_MAX.body),
    fields: shownFields(fields),
    fingerprint: fingerprintOf(raw, fields, fingerprintFields),
  }
  return { item }
}

/** The item list poll() returned, bare or as { items }; null when it returned neither. */
function listOf(value: unknown): unknown[] | null {
  const list: unknown = isRecord(value) ? value.items : value
  return Array.isArray(list) ? (list as unknown[]) : null
}

/** Usable items in order, and a note for each one left out. */
function readItems(list: readonly unknown[], fingerprintFields: readonly string[]) {
  const items: PollerItem[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of list.slice(0, POLLER_LIMITS.maxItems).entries()) {
    const read = readItem(raw, fingerprintFields)
    const at = `Item ${String(index + 1)}`
    if ('problem' in read) {
      invalid.push(`${at}: ${read.problem}`)
    } else if (seen.has(read.item.key)) {
      invalid.push(`${at}: the key ${read.item.key} came twice`)
    } else {
      seen.add(read.item.key)
      items.push(read.item)
    }
  }
  return { items, invalid }
}

/** Reads what poll() returned: an array of items, or { items, state }. */
export function readOutput(value: unknown, fingerprintFields: readonly string[]): ReadOutput | { error: string } {
  const list = listOf(value)
  if (list === null) {
    return { error: 'poll() must return an array of items, or { items, state }' }
  }
  const state = isRecord(value) && 'state' in value ? value.state : undefined
  if (state !== undefined && Buffer.byteLength(JSON.stringify(state)) > POLLER_LIMITS.stateMaxBytes) {
    return { error: `The state is over ${String(POLLER_LIMITS.stateMaxBytes / 1024)} KB` }
  }
  const { items, invalid } = readItems(list, fingerprintFields)
  const over = list.length - POLLER_LIMITS.maxItems
  const shown = invalid.slice(0, INVALID_SHOWN)
  if (invalid.length > INVALID_SHOWN) {
    shown.push(`${String(invalid.length - INVALID_SHOWN)} more items were not usable`)
  }
  if (over > 0) {
    shown.push(`${String(over)} items over the limit of ${String(POLLER_LIMITS.maxItems)} were left out`)
  }
  return { items, invalid: shown, complete: over <= 0 && invalid.length === 0, state }
}

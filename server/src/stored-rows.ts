import { checkMessageBody, type MessageBody, type StoredBody } from '@seti/shared'

type Payloads = { [B in MessageBody as B['kind']]: B['payload'] }

export interface RowRef {
  task_id: string
  id: number
}

const KIND_CHARS = 40
const WARNED_MAX = 10_000
const warned = new Set<string>()

/** One structured warning per row and process; the content is never logged. */
function warnUnreadable(row: RowRef, kind: string, reason: string): void {
  const key = `${row.task_id}:${String(row.id)}`
  if (warned.has(key)) {
    return
  }
  if (warned.size >= WARNED_MAX) {
    warned.clear()
  }
  warned.add(key)
  const entry = { level: 'warn', msg: 'unreadable transcript row', task_id: row.task_id, message_id: row.id }
  process.stderr.write(`${JSON.stringify({ ...entry, kind: kind.slice(0, KIND_CHARS), reason })}\n`)
}

type Parsed = { ok: true; value: unknown } | { ok: false }

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** A message body as Seti reads it, or an unreadable stand-in the UI shows as such. */
export function readBody(row: RowRef, kind: string, payload: unknown): StoredBody {
  const checked = checkMessageBody(kind, payload)
  if (checked.ok) {
    return checked.body
  }
  warnUnreadable(row, kind, checked.reason)
  return { kind: 'unreadable', payload: { kind: kind.slice(0, KIND_CHARS), reason: checked.reason } }
}

/** A stored payload's JSON read as `kind`; invalid JSON reads as unreadable too. */
export function readStoredBody(row: RowRef, kind: string, payload: string): StoredBody {
  const parsed = parseJson(payload)
  if (parsed.ok) {
    return readBody(row, kind, parsed.value)
  }
  warnUnreadable(row, kind, 'invalid JSON')
  return { kind: 'unreadable', payload: { kind: kind.slice(0, KIND_CHARS), reason: 'invalid JSON' } }
}

/** The payload of a stored row that must be of `kind`, or null when it does not fit. */
export function readPayload<K extends keyof Payloads>(row: RowRef, kind: K, payload: string): Payloads[K] | null {
  const body = readStoredBody(row, kind, payload)
  if (body.kind !== kind) {
    return null
  }
  return body.payload as Payloads[K]
}

/** The top-level fields of a stored payload, as the SQL filters see them; none unless an object. */
export function storedFields(payload: string): Partial<Record<string, unknown>> {
  const parsed = parseJson(payload)
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)
    ? parsed.value
    : {}
}

/** The outward actions a row recorded; anything but a list of strings reads as none. */
export function readOutward(outward: string): string[] {
  const parsed = parseJson(outward)
  return parsed.ok && Array.isArray(parsed.value) ? parsed.value.filter((item) => typeof item === 'string') : []
}

/** NUL and unpaired surrogates, which Postgres refuses in the JSON its search trigger reads. */
const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** A payload as stored: JSON whose strings Postgres accepts, with U+FFFD for what it refuses. */
export const storedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? item.replace(UNSTORABLE, '\uFFFD') : item))

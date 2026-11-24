import { noValue } from './egress-answers.js'
import type { BodyType } from './egress-body.js'
import type { EgressPlaceholder, Refusal } from './egress-placeholders.js'

const LINE_BREAK = /[\r\n]/
const BOUNDARY = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i

/** Every `needle` in `bytes` replaced, leaving every other byte as it was. */
function replaceBytes(bytes: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  const parts: Buffer[] = []
  let from = 0
  for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, from)) {
    parts.push(bytes.subarray(from, at), replacement)
    from = at + needle.length
  }
  parts.push(bytes.subarray(from))
  return Buffer.concat(parts)
}

function splitBytes(bytes: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let from = 0
  for (let at = bytes.indexOf(delimiter); at >= 0; at = bytes.indexOf(delimiter, from)) {
    parts.push(bytes.subarray(from, at))
    from = at + delimiter.length
  }
  parts.push(bytes.subarray(from))
  return parts
}

/** A multipart part with the value in its content: only a text field, never a file or its headers. */
function textPart(part: Buffer, needle: Buffer, replacement: Buffer): Buffer | null {
  const end = part.indexOf('\r\n\r\n')
  if (end < 0 || part.subarray(0, end).includes(needle)) {
    return null
  }
  const head = part.subarray(0, end).toString('latin1').toLowerCase()
  const type = /content-type:\s*([^;\r\n]*)/.exec(head)?.[1]?.trim()
  if (/filename\*?=/.test(head) || (type !== undefined && type !== 'text/plain')) {
    return null
  }
  return Buffer.concat([part.subarray(0, end), replaceBytes(part.subarray(end), needle, replacement)])
}

function multipartSwap(body: Buffer, contentType: string, needle: Buffer, value: string): Buffer | null {
  const match = BOUNDARY.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (boundary === undefined || LINE_BREAK.test(value)) {
    return null
  }
  const delimiter = Buffer.from(`--${boundary}`)
  const replacement = Buffer.from(value)
  const parts = splitBytes(body, delimiter)
  const swapped = parts
    .map((part) => (part.includes(needle) ? textPart(part, needle, replacement) : part))
    .filter((part) => part !== null)
  if (swapped.length !== parts.length) {
    return null
  }
  return Buffer.concat(swapped.flatMap((part, at) => (at === 0 ? [part] : [delimiter, part])))
}

/** The value as the body type writes it: JSON string-escaped, form URL-encoded, plain text raw. */
function encoded(type: Exclude<BodyType, 'multipart'>, value: string): Buffer | null {
  switch (type) {
    case 'json':
      return Buffer.from(JSON.stringify(value).slice(1, -1))
    case 'form':
      try {
        return Buffer.from(encodeURIComponent(value))
      } catch {
        return null
      }
    case 'text':
      return Buffer.from(value)
  }
}

/** The body with one placeholder swapped for its value, or null when the value cannot go there. */
export function swapInBody(
  body: Buffer,
  content: { type: BodyType; contentType: string },
  placeholder: string,
  value: string,
): Buffer | null {
  const needle = Buffer.from(placeholder)
  if (content.type === 'multipart') {
    return multipartSwap(body, content.contentType, needle, value)
  }
  const replacement = encoded(content.type, value)
  return replacement === null ? null : replaceBytes(body, needle, replacement)
}

const cannotPlace = (name: string): Refusal => ({
  status: 422,
  reason: 'Unprocessable Entity',
  body:
    `Seti sandbox proxy: refused a body it cannot put the value of ${name} in. Seti swaps a value into ` +
    'JSON, form and plain text bodies and into multipart text fields, never into a file or a part header.',
})

const unreadable = (name: string): Refusal => ({
  status: 502,
  reason: 'Bad Gateway',
  body: `Seti sandbox proxy has no value for the connection ${name}. Ask the user to set it.`,
})

/** The body with each found connection's value swapped in, read now; else the refusal. */
export async function swapBody(
  body: Buffer,
  content: { type: BodyType; contentType: string },
  found: readonly EgressPlaceholder[],
): Promise<Buffer | Refusal> {
  let swapped = body
  for (const entry of found) {
    const value = await entry.value().catch(noValue)
    if (value === null || value === '') {
      return unreadable(entry.name)
    }
    const next = swapInBody(swapped, content, entry.placeholder, value)
    if (next === null) {
      return cannotPlace(entry.name)
    }
    swapped = next
  }
  return swapped
}

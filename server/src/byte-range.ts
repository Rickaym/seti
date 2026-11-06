/** What a Range header asks of a file: all of it, one slice, or nothing it holds. */
export type ByteRange = { kind: 'full' } | { kind: 'part'; start: number; end: number } | { kind: 'unsatisfiable' }

const FULL: ByteRange = { kind: 'full' }
const UNSATISFIABLE: ByteRange = { kind: 'unsatisfiable' }

/** One range of bytes; a list of ranges, another unit or anything else reads as no range. */
const SINGLE = /^bytes=(\d*)-(\d*)$/i

/** More digits than this is past any file a share holds, and past exact float integers too. */
const DIGITS_MAX = 15

const position = (digits: string) => (digits.length > DIGITS_MAX ? Number.POSITIVE_INFINITY : Number(digits))

/**
 * The slice a Range header names in a file of the given size, by RFC 9110: `a-b`, `a-` and `-n`.
 * A header that does not parse, or names several ranges, is ignored and the whole file is sent.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header === undefined ? null : SINGLE.exec(header.trim())
  const [first = '', last = ''] = match === null ? [] : match.slice(1)
  if (match === null || (first === '' && last === '')) {
    return FULL
  }
  if (first === '') {
    const suffix = position(last)
    return suffix === 0 || size === 0
      ? UNSATISFIABLE
      : { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = position(first)
  const end = last === '' ? Number.POSITIVE_INFINITY : position(last)
  if (end < start) {
    return FULL
  }
  return start >= size ? UNSATISFIABLE : { kind: 'part', start, end: Math.min(end, size - 1) }
}

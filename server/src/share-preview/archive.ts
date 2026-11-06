import zlib from 'node:zlib'
import { escapeHtml } from '../share-markdown.js'
import { count, plural, type RenderedPreview } from './preview.js'

const ENTRIES_MAX = 1000
/** A compressed tar is inflated only this far; a listing never needs more and a bomb gets no more. */
const INFLATE_MAX = 64 * 1024 * 1024
const NAME_MAX = 1024

interface ArchiveEntry {
  name: string
  size: number
  /** ISO time, or null when the archive gives none. */
  modified: string | null
  folder: boolean
}

interface Listing {
  entries: ArchiveEntry[]
  /** Every entry the archive declares, which may be more than were read. */
  total: number
  /** Why the listing stops early, if it does. */
  cut: string | null
}

const EOCD = 0x06054b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50

/** A DOS date and time as an ISO string. */
function dosTime(date: number, time: number): string | null {
  const year = 1980 + (date >> 9)
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f
  if (month < 1 || month > 12 || day < 1) {
    return null
  }
  const at = Date.UTC(year, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2)
  return new Date(at).toISOString()
}

const clipName = (name: string) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}\u2026` : name)

function findEnd(bytes: Buffer): number {
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD) {
      return at
    }
  }
  return -1
}

/** Where the central directory starts and how many entries it says it has, ZIP64 included. */
function directory(bytes: Buffer, end: number): { offset: number; total: number } {
  const locator = end - 20
  if (locator >= 0 && bytes.readUInt32LE(locator) === EOCD64_LOCATOR) {
    const record = Number(bytes.readBigUInt64LE(locator + 8))
    if (record + 56 <= bytes.length) {
      return { total: Number(bytes.readBigUInt64LE(record + 32)), offset: Number(bytes.readBigUInt64LE(record + 48)) }
    }
  }
  return { total: bytes.readUInt16LE(end + 10), offset: bytes.readUInt32LE(end + 16) }
}

/** A zip's entries from its central directory; no entry is inflated or written anywhere. */
export function zipListing(bytes: Buffer): Listing | null {
  const end = findEnd(bytes)
  if (end < 0) {
    return null
  }
  const { offset, total } = directory(bytes, end)
  const entries: ArchiveEntry[] = []
  let at = offset
  while (entries.length < Math.min(total, ENTRIES_MAX) && at + 46 <= bytes.length) {
    if (bytes.readUInt32LE(at) !== CENTRAL) {
      return { entries, total, cut: 'the zip directory is damaged past here' }
    }
    const nameLength = bytes.readUInt16LE(at + 28)
    const raw = bytes.subarray(at + 46, Math.min(at + 46 + nameLength, bytes.length))
    const name = clipName(raw.toString((bytes.readUInt16LE(at + 8) & 0x800) === 0 ? 'latin1' : 'utf8'))
    entries.push({
      name,
      size: bytes.readUInt32LE(at + 24),
      modified: dosTime(bytes.readUInt16LE(at + 14), bytes.readUInt16LE(at + 12)),
      folder: name.endsWith('/'),
    })
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  const short = entries.length < Math.min(total, ENTRIES_MAX)
  return { entries, total, cut: short ? 'the zip directory ends early' : null }
}

/** A field up to its first NUL. */
const cString = (field: Buffer, encoding: BufferEncoding = 'utf8') => {
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString(encoding)
}

const octal = (field: Buffer) => {
  const text = cString(field, 'latin1').trim()
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : 0
}

/** A tar header's checksum: its bytes summed with the checksum field read as spaces. */
function checksumOk(header: Buffer): boolean {
  let sum = 0
  for (const [n, byte] of header.entries()) {
    sum += n >= 148 && n < 156 ? 32 : byte
  }
  return sum === octal(header.subarray(148, 156))
}

/** A pax header's path, which overrides the next entry's name. */
function paxPath(data: Buffer): string | null {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.subarray(0, 65_536).toString('utf8'))
  return match?.[1] ?? null
}

/** The name a GNU long-name or pax header gives the next entry; a global header gives none. */
function metaName(type: string, data: Buffer): string | null {
  if (type === 'g') {
    return null
  }
  return type === 'L' ? cString(data.subarray(0, NAME_MAX * 4)) : paxPath(data)
}

function tarEntry(header: Buffer, size: number, longName: string | null): ArchiveEntry {
  const prefix = cString(header.subarray(345, 500))
  const short = cString(header.subarray(0, 100))
  const mtime = octal(header.subarray(136, 148))
  return {
    name: clipName(longName ?? (prefix === '' ? short : `${prefix}/${short}`)),
    size,
    modified: mtime === 0 ? null : new Date(mtime * 1000).toISOString(),
    folder: header[156] === 0x35,
  }
}

/** A tar's entries from its headers, stepping over each entry's data. */
export function tarListing(bytes: Buffer, cut: string | null = null): Listing | null {
  const entries: ArchiveEntry[] = []
  let longName: string | null = null
  let at = 0
  while (at + 512 <= bytes.length && entries.length < ENTRIES_MAX) {
    const header = bytes.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) {
      return { entries, total: entries.length, cut }
    }
    if (!checksumOk(header)) {
      return at === 0 ? null : { entries, total: entries.length, cut: 'the tar is damaged past here' }
    }
    const size = octal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156] ?? 0)
    const data = bytes.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'L' || type === 'x' || type === 'g') {
      longName = metaName(type, data) ?? longName
      continue
    }
    entries.push(tarEntry(header, size, longName))
    longName = null
  }
  const more = entries.length >= ENTRIES_MAX ? 'more entries follow' : cut
  return { entries, total: entries.length, cut: more }
}

/** The first 64 MB of a gzip stream, inflated off the event loop, or null when it is not gzip. */
export async function inflateHead(bytes: Buffer): Promise<{ data: Buffer; whole: boolean } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    const gunzip = zlib.createGunzip()
    gunzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= INFLATE_MAX) {
        gunzip.destroy()
        resolve({ data: Buffer.concat(chunks).subarray(0, INFLATE_MAX), whole: false })
      }
    })
    gunzip.on('end', () => {
      resolve({ data: Buffer.concat(chunks), whole: true })
    })
    gunzip.on('error', () => {
      resolve(total === 0 ? null : { data: Buffer.concat(chunks), whole: false })
    })
    gunzip.end(bytes)
  })
}

/** A path that would land outside the folder it is unpacked in, flagged in the listing. */
const unsafePath = (name: string) =>
  name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function bytesLabel(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${String(value)} B` : `${value.toFixed(1)} ${UNITS[unit] ?? ''}`
}

function row(entry: ArchiveEntry): string {
  const flag = unsafePath(entry.name) ? ' <span class="flag">unsafe path</span>' : ''
  const when = entry.modified === null ? '' : `${entry.modified.slice(0, 10)} ${entry.modified.slice(11, 16)}`
  return [
    `<tr><td class="name">${escapeHtml(entry.name)}${flag}</td>`,
    `<td class="num">${entry.folder ? '' : escapeHtml(bytesLabel(entry.size))}</td>`,
    `<td>${escapeHtml(when)}</td></tr>`,
  ].join('')
}

/** A listing of a zip or tar archive: names, sizes and times, read without unpacking anything. */
export function archivePreview(format: string, listing: Listing): RenderedPreview {
  const declared = listing.entries.reduce((sum, entry) => sum + entry.size, 0)
  const shown = listing.entries.length
  const notes = [listing.total > shown ? `first ${count(shown)} entries shown` : null, listing.cut].filter(
    (note) => note !== null,
  )
  const label = `${format} archive, ${plural(listing.total, 'entry', 'entries')}`
  const caption = `${label}, ${bytesLabel(declared)} unpacked${shown < listing.total ? ' in those shown' : ''}`
  const body = [
    `<p class="caption">${escapeHtml([caption, ...notes].join(', '))}</p>`,
    '<div class="table"><table class="listing"><thead><tr><th>Path</th><th>Size</th><th>Modified</th></tr></thead><tbody>',
    listing.entries.map(row).join(''),
    '</tbody></table></div>',
  ].join('')
  return { body, label, note: notes.length === 0 ? null : notes.join(', '), error: null, thumb: null }
}

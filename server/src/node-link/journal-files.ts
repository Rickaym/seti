import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { journalEntry, type JournalEntry } from '@seti/shared'

const SEGMENT_NAME = /^(\d{16})\.jsonl$/
const EPOCH_FILE = 'epoch'

/** One append-only file of consecutive entries, named after its first sequence number. */
export interface Segment {
  first: number
  last: number
  file: string
  bytes: number
}

/** A journal file that holds a broken entry before valid ones; it is never repaired silently. */
export class JournalCorruptError extends Error {
  override readonly name = 'JournalCorruptError'
}

export const segmentFile = (dir: string, first: number) => path.join(dir, `${String(first).padStart(16, '0')}.jsonl`)

function parseEntry(line: string): JournalEntry | null {
  try {
    const parsed = journalEntry.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Makes a directory's new or renamed entries survive a crash. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The journal's epoch, made once when the journal is created and kept in its directory. */
export async function readOrCreateEpoch(dir: string): Promise<string> {
  const file = path.join(dir, EPOCH_FILE)
  try {
    const epoch = (await fs.readFile(file, 'utf8')).trim()
    if (epoch.length === 0) {
      throw new JournalCorruptError(`empty epoch file in ${dir}`)
    }
    return epoch
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const epoch = randomUUID()
  const temporary = `${file}.${String(process.pid)}.tmp`
  const handle = await fs.open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(epoch)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
  await syncDir(dir)
  return epoch
}

/** Cuts a torn final write off the newest file; a bad line before good ones is corruption. */
async function recoverTail(file: string, first: number): Promise<{ last: number; bytes: number }> {
  const text = await fs.readFile(file, 'utf8')
  const lines = text.split('\n')
  let last = first - 1
  let bytes = 0
  for (const [index, line] of lines.entries()) {
    const entry = index < lines.length - 1 ? parseEntry(line) : null
    if (entry?.seq !== last + 1) {
      if (lines.slice(index + 1).some((rest) => rest.length > 0)) {
        throw new JournalCorruptError(`broken entry after seq ${String(last)} in ${file}`)
      }
      break
    }
    last = entry.seq
    bytes += Buffer.byteLength(line) + 1
  }
  if (bytes < Buffer.byteLength(text)) {
    await fs.truncate(file, bytes)
  }
  return { last, bytes }
}

/** The segments in a journal directory, oldest first, with the newest one recovered. */
export async function scanSegments(dir: string): Promise<Segment[]> {
  const firsts = (await fs.readdir(dir))
    .map((name) => SEGMENT_NAME.exec(name)?.[1])
    .filter((digits) => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
  const segments: Segment[] = firsts.map((first, index) => ({
    first,
    last: (firsts[index + 1] ?? first) - 1,
    file: segmentFile(dir, first),
    bytes: 0,
  }))
  const newest = segments.at(-1)
  if (newest === undefined) {
    return segments
  }
  const { last, bytes } = await recoverTail(newest.file, newest.first)
  if (last < newest.first && segments.length > 1) {
    await fs.unlink(newest.file)
    return segments.slice(0, -1)
  }
  newest.last = last
  newest.bytes = bytes
  return segments
}

/** Reads the entries of one segment after `after` and up to `upTo`, skipping torn lines. */
export async function readSegment(segment: Segment, after: number, upTo: number): Promise<JournalEntry[]> {
  let text: string
  try {
    text = await fs.readFile(segment.file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  return text
    .split('\n')
    .map(parseEntry)
    .filter((entry): entry is JournalEntry => entry !== null && entry.seq > after && entry.seq <= upTo)
}

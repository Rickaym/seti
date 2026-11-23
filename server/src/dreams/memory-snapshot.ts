import fs from 'node:fs/promises'
import path from 'node:path'
import { asText, MEMORY_CAP, sha256 } from './memory-files.js'

interface MemoryFile {
  text: string
  sha256: string
}

/** The text files of a memory folder by their path inside it; links and binary files are left out. */
export type MemorySnapshot = ReadonlyMap<string, MemoryFile>

export type SnapshotResult = { ok: true; files: MemorySnapshot } | { ok: false; reason: string }

interface Limit {
  bytes: number
  files: number
}

const byPath = (a: string, b: string) => a.localeCompare(b, 'en')

/** Claude Code's own consolidation lock, which holds a process id, not memory. */
const CLAUDE_LOCK = '.consolidate-lock'

/** Every regular file under dir, by its path inside it; links are neither listed nor followed. */
async function regularFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true }).catch((e: unknown) => {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT' && prefix === '') {
      return []
    }
    throw e
  })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) {
        return regularFiles(dir, file)
      }
      return entry.isFile() && file !== CLAUDE_LOCK ? [file] : []
    }),
  )
  return nested.flat()
}

/**
 * The memory folder's text files, refused when it holds more than the limit; a missing folder is
 * empty. The limit counts every regular file, text or not.
 */
export async function snapshotMemory(dir: string, limit: Limit = MEMORY_CAP): Promise<SnapshotResult> {
  if ((await fs.lstat(dir).catch(() => null))?.isSymbolicLink() === true) {
    return { ok: false, reason: 'The memory folder is a link.' }
  }
  const names = (await regularFiles(dir)).sort(byPath)
  if (names.length > limit.files) {
    return { ok: false, reason: `The memory folder holds more than ${String(limit.files)} files.` }
  }
  const files = new Map<string, MemoryFile>()
  let bytes = 0
  for (const name of names) {
    const data = await fs.readFile(path.join(dir, name))
    bytes += data.length
    if (bytes > limit.bytes) {
      return { ok: false, reason: `The memory folder holds more than ${String(limit.bytes / 1024)} KB.` }
    }
    const text = asText(data)
    if (text !== null) {
      files.set(name, { text, sha256: sha256(data) })
    }
  }
  return { ok: true, files }
}

export interface MemoryChange {
  file: string
  before: MemoryFile | null
  after: MemoryFile | null
}

/** The files that differ between two snapshots, in path order. */
export function memoryChanges(before: MemorySnapshot, after: MemorySnapshot): MemoryChange[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort(byPath)
  return names.flatMap((file) => {
    const was = before.get(file) ?? null
    const now = after.get(file) ?? null
    return was?.sha256 === now?.sha256 ? [] : [{ file, before: was, after: now }]
  })
}

/** Lines added and removed, counted as a multiset, which is what a summary needs. */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>()
  const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))
  for (const line of lines(before)) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of lines(after)) {
    const left = counts.get(line) ?? 0
    if (left > 0) {
      counts.set(line, left - 1)
    } else {
      added++
    }
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0)
  return { added, removed }
}

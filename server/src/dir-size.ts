import fs from 'node:fs'
import path from 'node:path'
import type { FolderSize } from '@seti/shared'

/** How far one walk goes before it stops and reports a floor: entries seen and time spent. */
export interface WalkCaps {
  entries: number
  ms: number
}

export const SIZE_CAPS: WalkCaps = { entries: 400_000, ms: 20_000 }

const STAT_BATCH = 64

/** A folder's size and the size of each folder directly in it, from one walk. */
export interface Walked {
  size: FolderSize
  children: Map<string, FolderSize>
}

interface Pending {
  dir: string
  /** The folder directly in the walked one that this one lies in; null for the walked one. */
  top: string | null
}

interface Tally {
  bytes: number
  files: number
}

const tallied = (tally: Tally, bytes: number): Tally => ({ bytes: tally.bytes + bytes, files: tally.files + 1 })

async function readDir(dir: string): Promise<fs.Dirent[]> {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
}

/** Files counted once each, so hard links, such as a package store's, do not count twice. */
async function statFiles(files: readonly string[], seen: Set<string>): Promise<number[]> {
  const sizes: number[] = []
  for (let start = 0; start < files.length; start += STAT_BATCH) {
    const batch = files.slice(start, start + STAT_BATCH)
    const stats = await Promise.all(batch.map(async (file) => fs.promises.lstat(file).catch(() => null)))
    for (const stat of stats) {
      const key = stat !== null && stat.nlink > 1 ? `${String(stat.dev)}:${String(stat.ino)}` : null
      if (stat !== null && (key === null || !seen.has(key))) {
        sizes.push(stat.size)
      }
      if (key !== null) {
        seen.add(key)
      }
    }
  }
  return sizes
}

/** One walk's running state: totals for the folder and each folder directly in it, and its queue. */
class Walk {
  total: Tally = { bytes: 0, files: 0 }
  readonly children = new Map<string, Tally>()
  readonly seen = new Set<string>()
  readonly queue: Pending[]
  entries = 0

  constructor(dir: string) {
    this.queue = [{ dir, top: null }]
  }

  /** Queues the folders in one folder and counts its files toward the totals they belong to. */
  async visit(next: Pending): Promise<void> {
    const dirents = await readDir(next.dir)
    this.entries += dirents.length
    const files: string[] = []
    for (const dirent of dirents) {
      const full = path.join(next.dir, dirent.name)
      if (dirent.isDirectory()) {
        if (next.top === null) {
          this.children.set(dirent.name, { bytes: 0, files: 0 })
        }
        this.queue.push({ dir: full, top: next.top ?? dirent.name })
      } else if (dirent.isFile()) {
        files.push(full)
      }
    }
    for (const bytes of await statFiles(files, this.seen)) {
      this.total = tallied(this.total, bytes)
      const child = next.top === null ? undefined : this.children.get(next.top)
      if (next.top !== null && child !== undefined) {
        this.children.set(next.top, tallied(child, bytes))
      }
    }
  }
}

/**
 * Bytes and files under `dir`, and under each folder directly in it, by apparent size. Symlinks
 * are never followed and count nothing. The walk stops at `caps`, marking every size it gave
 * as a floor.
 */
export async function walkSize(
  dir: string,
  caps: WalkCaps = SIZE_CAPS,
  clock: () => number = Date.now,
): Promise<Walked> {
  const started = clock()
  const walk = new Walk(dir)
  let capped = false
  for (let next = walk.queue.pop(); next !== undefined; next = walk.queue.pop()) {
    if (walk.entries >= caps.entries || clock() - started > caps.ms) {
      capped = true
      break
    }
    await walk.visit(next)
  }
  const sized = (tally: Tally): FolderSize => ({ ...tally, capped })
  return { size: sized(walk.total), children: new Map([...walk.children].map(([name, tally]) => [name, sized(tally)])) }
}

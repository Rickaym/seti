import path from 'node:path'
import type { FolderSize } from '@seti/shared'
import { SIZE_CAPS, walkSize, type WalkCaps } from './dir-size.js'
import { within } from './owned-dirs.js'

/** How long a measured size stands before a read schedules it again; the old one shows meanwhile. */
const SIZE_TTL_MS = 10 * 60_000
const JOBS_MAX = 2000
const SIZES_MAX = 50_000

interface Job {
  key: string
  run: () => Promise<void>
}

/** One background job at a time, so measuring never competes with itself for the disk. */
const jobs: Job[] = []
const queued = new Set<string>()
let draining: Promise<void> | null = null

async function drain(): Promise<void> {
  for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
    try {
      await job.run()
    } catch (e) {
      process.stderr.write(`storage: ${job.key} failed: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      queued.delete(job.key)
    }
  }
}

/** Queues a job unless the same one waits already; a full queue drops it until the next read. */
function schedule(key: string, run: () => Promise<void>): void {
  if (queued.has(key) || jobs.length >= JOBS_MAX) {
    return
  }
  queued.add(key)
  jobs.push({ key, run })
  draining ??= drain().finally(() => {
    draining = null
  })
}

/** Whether background jobs wait or run, so a reader knows to ask again. */
export const measuring = (): boolean => draining !== null

/** Resolves once the background queue is empty. */
export async function settled(): Promise<void> {
  while (draining !== null) {
    await draining
  }
}

interface Entry {
  size: FolderSize
  at: number
}

const sizes = new Map<string, Entry>()

function keep(dir: string, size: FolderSize, at: number): void {
  if (sizes.size >= SIZES_MAX) {
    sizes.clear()
  }
  sizes.set(dir, { size, at })
}

/** Walks a folder now and keeps its size and its direct folders' sizes. */
export async function measureNow(dir: string, caps: WalkCaps = SIZE_CAPS): Promise<FolderSize> {
  const walked = await walkSize(dir, caps)
  const at = Date.now()
  keep(dir, walked.size, at)
  for (const [name, size] of walked.children) {
    keep(path.join(dir, name), size, at)
  }
  return walked.size
}

/** A folder's last measured size, or null; a missing or old one is measured in the background. */
export function cachedSize(dir: string, at = Date.now()): FolderSize | null {
  const entry = sizes.get(dir)
  if (entry === undefined || at - entry.at > SIZE_TTL_MS) {
    schedule(`size:${dir}`, async () => {
      await measureNow(dir)
    })
  }
  return entry?.size ?? null
}

/** A size measured within the TTL, else one measured now; for what a removal frees. */
export async function freshSize(dir: string): Promise<FolderSize> {
  const entry = sizes.get(dir)
  return entry !== undefined && Date.now() - entry.at <= SIZE_TTL_MS ? entry.size : measureNow(dir)
}

/** Larger first, an unmeasured size counting as nothing; a number sort's comparator. */
export const bySize = (a: FolderSize | null, b: FolderSize | null): number => (b?.bytes ?? 0) - (a?.bytes ?? 0)

/** Drops the sizes a removal made wrong: the folder, everything in it and every folder above it. */
export function forgetSizes(dir: string): void {
  for (const key of sizes.keys()) {
    if (within(key, dir) || within(dir, key)) {
      sizes.delete(key)
    }
  }
}

/** Values worked out in the same background queue, such as a Clean plan, kept for `ttlMs`. */
export class BackgroundMemo<T> {
  private readonly values = new Map<string, { value: T; at: number }>()
  private readonly name: string
  private readonly ttlMs: number

  constructor(name: string, ttlMs: number) {
    this.name = name
    this.ttlMs = ttlMs
  }

  /** The last value for `key`, or null; a missing or old one is worked out again in the background. */
  get(key: string, compute: () => Promise<T>, at = Date.now()): T | null {
    const entry = this.values.get(key)
    if (entry === undefined || at - entry.at > this.ttlMs) {
      schedule(`${this.name}:${key}`, async () => {
        this.values.set(key, { value: await compute(), at: Date.now() })
      })
    }
    return entry?.value ?? null
  }

  /** Whether a value for `key` was worked out, however old. */
  has(key: string): boolean {
    return this.values.has(key)
  }

  forget(key: string): void {
    this.values.delete(key)
  }
}

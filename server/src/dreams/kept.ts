import fs from 'node:fs'
import path from 'node:path'
import type { DreamRun } from '@seti/shared'
import { maintenanceDirOf } from '../task-proxy.js'
import { recordMemoryChanges } from './memory-revisions.js'
import { memoryChanges, snapshotMemory, type MemorySnapshot } from './memory-snapshot.js'
import { tripwire } from './tripwire.js'

/** What reading a memory folder after a dream allows: past the cap, so a breach is still recorded. */
const AFTER_LIMIT = { bytes: 4 * 1024 * 1024, files: 400 }

/** Where a running dream's memory before it began is kept, outside anything its sandbox shows. */
const keptFile = (taskId: string, runId: number) => path.join(maintenanceDirOf(taskId), `before-${String(runId)}.json`)

/** Keeps the snapshot a dream started from on disk, so a dream a restart cut is still recorded. */
export function keepBefore(taskId: string, runId: number, before: MemorySnapshot): void {
  fs.mkdirSync(maintenanceDirOf(taskId), { recursive: true, mode: 0o700 })
  fs.writeFileSync(keptFile(taskId, runId), JSON.stringify([...before]), { mode: 0o600 })
}

export function forgetBefore(taskId: string, runId: number): void {
  fs.rmSync(keptFile(taskId, runId), { force: true })
}

/** The snapshot a cut dream started from, or null when none was kept. */
export function keptBefore(taskId: string, runId: number): MemorySnapshot | null {
  try {
    const entries = JSON.parse(fs.readFileSync(keptFile(taskId, runId), 'utf8')) as [
      string,
      { text: string; sha256: string },
    ][]
    return new Map(entries)
  } catch {
    return null
  }
}

/**
 * Reads the memory folder after a dream, records each changed file as a revision, and returns how
 * many changed and the lines Seti adds to the report's found list.
 */
export async function recordAfter(
  taskId: string,
  run: Pick<DreamRun, 'night'>,
  memory: string,
  before: MemorySnapshot,
): Promise<{ changes: number; found: string[] }> {
  const after = await snapshotMemory(memory, AFTER_LIMIT)
  if (!after.ok) {
    return { changes: 0, found: [`Seti: ${after.reason} Its changes were not recorded; check the folder by hand.`] }
  }
  const recorded = await recordMemoryChanges(taskId, `dream ${run.night}`, before, after.files)
  const found = memoryChanges(before, after.files).flatMap((change) =>
    tripwire(change.file, change.before?.text ?? '', change.after?.text ?? ''),
  )
  return { changes: recorded.length, found }
}

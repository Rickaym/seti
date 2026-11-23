import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RevisionState } from '@seti/shared'
import { z } from 'zod'
import { redactCredentials } from '../scrub.js'

/** The most a memory folder may hold for a dream to snapshot it, and to grow to during one. */
export const MEMORY_CAP = { bytes: 512 * 1024, files: 100 }

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')

/**
 * A memory file as a revision keeps it: its text with credentials redacted, flagged when that
 * changed it, and the hash of the text as written; a missing file is `deleted`.
 */
export function memoryState(text: string | null): RevisionState {
  if (text === null) {
    return { text: '', sha256: '', deleted: true }
  }
  const redacted = redactCredentials(text)
  return redacted === text ? { text, sha256: sha256(text) } : { text: redacted, sha256: sha256(text), redacted: true }
}

export const memoryFileState = z.object({
  text: z.string(),
  sha256: z.string(),
  deleted: z.boolean().optional(),
  redacted: z.boolean().optional(),
})

/** Text decoded strictly, or null for a file that is not UTF-8 text. */
export function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) {
    return null
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const isMissing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT'

async function isLink(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink()
  } catch (e) {
    if (isMissing(e)) {
      return false
    }
    throw e
  }
}

/** A relative path's place inside the memory folder, or null when it leaves it or passes a link. */
export async function memoryPath(dir: string, file: string): Promise<string | null> {
  const parts = file.split('/')
  if (path.isAbsolute(file) || file.includes('\0') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    return null
  }
  let at = dir
  for (const part of ['', ...parts]) {
    at = path.join(at, part)
    if (await isLink(at)) {
      return null
    }
  }
  return at
}

/** The file's bytes, or null when it does not exist. */
export async function readMemoryFile(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch (e) {
    if (isMissing(e)) {
      return null
    }
    throw e
  }
}

/** Writes the text through a temporary file and a rename, or removes the file for null. */
export async function writeMemoryFile(file: string, text: string | null): Promise<void> {
  if (text === null) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}`)
  await fs.writeFile(temp, text, { mode: 0o600 })
  await fs.rename(temp, file)
}

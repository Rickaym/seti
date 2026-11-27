import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { InstallFailure } from '@seti/shared'

/** A fetch that failed, with the reason Settings shows and a message without any secret. */
export class InstallError extends Error {
  readonly reason: InstallFailure

  constructor(reason: InstallFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

/** A download that sends nothing for this long is cut, and the next try resumes it. */
const IDLE_MS = 60_000
/** The mode of a version folder and its program: Seti's user reads and runs them, nobody writes. */
export const READ_AND_RUN = 0o500
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EIO', 'EFBIG'])

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ''

/** A disk error as a refusal with its reason; anything else unchanged. */
export function onDisk(e: unknown): unknown {
  if (e instanceof InstallError || !DISK_CODES.has(errno(e))) {
    return e
  }
  return new InstallError('disk', `The disk refused the write (${errno(e)})`)
}

export async function digestOf(
  file: string,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64',
): Promise<string> {
  const hash = createHash(algorithm)
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest(encoding)
}

/** Files already checked against their sha256, by path and what their stat said then. */
const verified = new Map<string, string>()

/** Whether the file is there with the given sha256; a check runs once per file as it stands. */
export async function holdsSum(file: string, sha256: string): Promise<boolean> {
  const stat = await fs.promises.stat(file).catch(() => null)
  if (stat === null) {
    return false
  }
  const seen = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, sha256].join(':')
  if (verified.get(file) === seen) {
    return true
  }
  verified.delete(file)
  const matches = (await digestOf(file, 'sha256', 'hex').catch(() => '')) === sha256
  if (matches) {
    verified.set(file, seen)
  }
  return matches
}

/** Whether the tarball at `file` has the npm integrity the pin names. */
export const holdsIntegrity = async (file: string, integrity: string) =>
  `sha512-${await digestOf(file, 'sha512', 'base64')}` === integrity

/** Passes bytes on and calls `alive` for each chunk, so an idle timer starts over. */
const heartbeat = (alive: () => void) =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      alive()
      done(null, chunk)
    },
  })

async function request(url: string, from: number, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = from > 0 ? { range: `bytes=${String(from)}-` } : {}
  try {
    return await fetch(url, { headers, redirect: 'error', signal })
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e
    const why = cause instanceof Error ? cause.message : String(cause)
    throw new InstallError('network', `Could not reach ${new URL(url).host}: ${why}`)
  }
}

/**
 * Downloads the tarball into `file`, going on from the bytes a cut download left there when the
 * registry serves ranges. Only the pin's host is contacted: a redirect elsewhere fails.
 */
export async function download(url: string, file: string): Promise<void> {
  const have = (await fs.promises.stat(file).catch(() => null))?.size ?? 0
  const controller = new AbortController()
  let timer = setTimeout(() => {
    controller.abort()
  }, IDLE_MS)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      controller.abort()
    }, IDLE_MS)
  }
  try {
    const response = await request(url, have, controller.signal)
    if (response.status === 416 && have > 0) {
      return
    }
    if ((response.status !== 200 && response.status !== 206) || response.body === null) {
      throw new InstallError('network', `${new URL(url).host} answered ${String(response.status)}`)
    }
    const out = fs.createWriteStream(file, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 })
    await pipeline(Readable.fromWeb(response.body), heartbeat(alive), out).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e)
      throw DISK_CODES.has(errno(e)) ? e : new InstallError('network', `The download was cut: ${why}`)
    })
  } finally {
    clearTimeout(timer)
  }
}

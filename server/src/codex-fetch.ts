import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CodexFailure } from '@seti/shared'
import { z } from 'zod'
import { binaryPath } from './binaries.js'

/** One platform's build: the registry tarball, its npm integrity, the binary in it and its sha256. */
const platformPin = z.strictObject({
  tarball: z.url({ protocol: /^https?$/ }),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
  binary: z.string().regex(/^package(\/[\w.-]+)+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/** The Codex version Seti is built against and where each platform's build comes from. */
export const codexPinSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platforms: z.record(z.string(), platformPin),
})
export type CodexPin = z.infer<typeof codexPinSchema>

/** A fetch that failed, with the reason Settings shows and a message without any secret. */
export class CodexInstallError extends Error {
  readonly reason: CodexFailure

  constructor(reason: CodexFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

/** The program's name in its version folder, the only file that folder ever holds. */
const PROGRAM = 'codex'
const TARBALL = 'codex.tgz'
/** A download that sends nothing for this long is cut, and the next try resumes it. */
const IDLE_MS = 60_000
/** The mode of a version folder and its program: Seti's user reads and runs them, nobody writes. */
const READ_AND_RUN = 0o500
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EIO', 'EFBIG'])

export const versionDir = (root: string, version: string) => path.join(root, version)
export const programIn = (root: string, version: string) => path.join(root, version, PROGRAM)
/** Where a version downloads and unpacks before it moves into place, kept to resume. */
export const stagingDir = (root: string, version: string) => path.join(root, `.staging-${version}`)

/** This machine's build in the pin, or a refusal when the pin names none. */
export function platformOf(pin: CodexPin) {
  const key = `${process.platform}-${process.arch}`
  const build = pin.platforms[key]
  if (build === undefined) {
    throw new CodexInstallError('platform', `Codex ${pin.version} has no build for ${key}`)
  }
  return build
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ''

/** A disk error as a refusal with its reason; anything else unchanged. */
function onDisk(e: unknown): unknown {
  if (e instanceof CodexInstallError || !DISK_CODES.has(errno(e))) {
    return e
  }
  return new CodexInstallError('disk', `The disk refused the write (${errno(e)})`)
}

async function digestOf(file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
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
    throw new CodexInstallError('network', `Could not reach ${new URL(url).host}: ${why}`)
  }
}

/**
 * Downloads the tarball into `file`, going on from the bytes a cut download left there when the
 * registry serves ranges. Only the pin's host is contacted: a redirect elsewhere fails.
 */
async function download(url: string, file: string): Promise<void> {
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
      throw new CodexInstallError('network', `${new URL(url).host} answered ${String(response.status)}`)
    }
    const out = fs.createWriteStream(file, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 })
    await pipeline(Readable.fromWeb(response.body), heartbeat(alive), out).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e)
      throw DISK_CODES.has(errno(e)) ? e : new CodexInstallError('network', `The download was cut: ${why}`)
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Unpacks one member of the tarball into `to` with tar, given an argument list and no shell. */
async function unpack(tarball: string, member: string, to: string): Promise<void> {
  const program = binaryPath('tar')
  if (program === null) {
    throw new CodexInstallError('platform', 'This machine has no tar program to unpack Codex with')
  }
  const tar = spawn(program, ['-xzOf', tarball, '--', member], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  tar.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-500)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    tar.once('error', reject)
    tar.once('close', resolve)
  })
  const [, code] = await Promise.all([pipeline(tar.stdout, fs.createWriteStream(to, { mode: 0o600 })), exited])
  if (code !== 0) {
    throw new CodexInstallError('checksum', `The pinned tarball holds no ${member}: ${stderr.trim()}`)
  }
}

export interface FetchOptions {
  pin: CodexPin
  /** The folder that holds one folder per version. */
  root: string
  /** Removes a folder of the root that holds a fetch that failed its checks. */
  discard: (dir: string) => Promise<void>
}

/** A version folder that is there but fails its checksum: it goes before a new fetch. */
async function dropChanged(options: FetchOptions): Promise<void> {
  const dir = versionDir(options.root, options.pin.version)
  if (fs.existsSync(dir)) {
    await options.discard(dir)
  }
}

/** Fetches and checks the tarball, then unpacks and checks the program; returns where it lies. */
async function fetchInto(options: FetchOptions, staging: string): Promise<string> {
  const { pin } = options
  const build = platformOf(pin)
  const tarball = path.join(staging, TARBALL)
  await download(build.tarball, tarball)
  if (`sha512-${await digestOf(tarball, 'sha512', 'base64')}` !== build.integrity) {
    await options.discard(staging)
    throw new CodexInstallError('checksum', `The tarball from ${new URL(build.tarball).host} fails its pinned sha512`)
  }
  const unpacked = path.join(staging, pin.version)
  const stat = await fs.promises.stat(unpacked).catch(() => null)
  if (stat !== null) {
    await fs.promises.chmod(unpacked, 0o700)
  }
  await fs.promises.mkdir(unpacked, { recursive: true, mode: 0o700 })
  const program = path.join(unpacked, PROGRAM)
  await unpack(tarball, build.binary, program)
  if ((await digestOf(program, 'sha256', 'hex')) !== build.sha256) {
    await options.discard(staging)
    throw new CodexInstallError('checksum', `The program in the tarball fails its pinned sha256`)
  }
  return unpacked
}

/**
 * Puts the pinned Codex at `<root>/<version>/codex` unless it is there already: downloads the
 * tarball, checks its sha512 and the program's sha256 against the pin, and only then moves a
 * folder holding the program alone into place, folder and program read and run only. A
 * check that fails discards what was fetched, so nothing unchecked ever runs.
 */
export async function fetchPinned(options: FetchOptions): Promise<{ program: string; fetched: boolean }> {
  const { pin, root } = options
  const build = platformOf(pin)
  const program = programIn(root, pin.version)
  if (await holdsSum(program, build.sha256)) {
    return { program, fetched: false }
  }
  try {
    await dropChanged(options)
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    const staging = stagingDir(root, pin.version)
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 })
    const unpacked = await fetchInto(options, staging)
    await fs.promises.chmod(path.join(unpacked, PROGRAM), READ_AND_RUN)
    await fs.promises.rename(unpacked, versionDir(root, pin.version))
    await fs.promises.chmod(versionDir(root, pin.version), READ_AND_RUN)
    await options.discard(staging)
  } catch (e) {
    throw onDisk(e)
  }
  return { program, fetched: true }
}

/**
 * Removes a fetch's own files from a folder by name, and the folder once it is empty; a folder
 * holding anything else stays. For folders no owned root covers, as the command line's are.
 */
export async function removeFetched(dir: string): Promise<void> {
  const version = path.basename(dir).replace(/^\.staging-/, '')
  const inner = path.join(dir, version)
  await fs.promises.chmod(dir, 0o700).catch(() => undefined)
  await fs.promises.chmod(inner, 0o700).catch(() => undefined)
  for (const file of [path.join(dir, PROGRAM), path.join(dir, TARBALL), path.join(inner, PROGRAM)]) {
    await fs.promises.rm(file, { force: true })
  }
  await fs.promises.rmdir(inner).catch(() => undefined)
  await fs.promises.rmdir(dir)
}

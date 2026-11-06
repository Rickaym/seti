import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { describeIssues } from '../http.js'

export function explain(e: unknown): string {
  if (e instanceof z.ZodError) {
    return describeIssues(e)
  }
  return e instanceof Error ? e.message : String(e)
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code

/** Errors that mean "no regular file of ours here": gone, a symlink, or not a directory. */
const NOT_OURS = new Set(['ENOENT', 'ELOOP', 'ENOTDIR'])

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants

/** Whether an open file really lives in the workspace, whatever symlinks led to it. */
function inside(fd: number, root: string): boolean {
  const real = fs.readlinkSync(`/proc/self/fd/${String(fd)}`)
  return real.startsWith(`${fs.realpathSync(root)}${path.sep}`)
}

/** Opens a regular file inside the workspace, never a planted symlink or FIFO; else null. */
function openOwn(root: string, rel: string): number | null {
  let fd: number
  try {
    fd = fs.openSync(path.join(root, rel), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (NOT_OURS.has(code(e) ?? '')) {
      return null
    }
    throw e
  }
  if (fs.fstatSync(fd).isFile() && inside(fd, root)) {
    return fd
  }
  fs.closeSync(fd)
  return null
}

function readFd(fd: number): string {
  const size = fs.fstatSync(fd).size
  const buffer = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const got = fs.readSync(fd, buffer, read, size - read, read)
    if (got === 0) {
      break
    }
    read += got
  }
  return buffer.subarray(0, read).toString('utf8')
}

/** A workspace file's text, or null when there is no regular file of the workspace at `rel`. */
export function readText(root: string, rel: string): string | null {
  const fd = openOwn(root, rel)
  if (fd === null) {
    return null
  }
  try {
    return readFd(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Makes each folder from the root down to the file a real folder, replacing what is not. */
function ownFolders(root: string, rel: string): void {
  let dir = root
  for (const part of path
    .dirname(rel)
    .split(path.sep)
    .filter((name) => name !== '' && name !== '.')) {
    dir = path.join(dir, part)
    const isFolder = fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()
    if (isFolder === false) {
      fs.rmSync(dir, { force: true })
    }
    if (isFolder !== true) {
      fs.mkdirSync(dir, { mode: 0o700 })
    }
  }
}

function atomicWrite(root: string, rel: string, text: string): void {
  ownFolders(root, rel)
  const file = path.join(root, rel)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    if (!inside(fd, root)) {
      throw new Error(`${rel} does not lead into the workspace`)
    }
    fs.writeFileSync(fd, text)
    fs.closeSync(fd)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export interface Swapped {
  ok: boolean
  /** What the replaced file held, and what it held after the swap when someone wrote to it. */
  before: string | null
  late: string | null
}

/** Replaces the file while it holds `expected`; `late` is what was appended to it meanwhile. */
export function swap(root: string, rel: string, next: string, expected?: string | null): Swapped {
  const fd = openOwn(root, rel)
  try {
    const before = fd === null ? null : readFd(fd)
    if (expected !== undefined && before !== expected) {
      return { ok: false, before, late: null }
    }
    atomicWrite(root, rel, next)
    const after = fd === null ? null : readFd(fd)
    return { ok: true, before, late: after === before ? null : after }
  } finally {
    if (fd !== null) {
      fs.closeSync(fd)
    }
  }
}

/** Removes a workspace file while it still holds `expected`. */
export function removeIf(root: string, rel: string, expected: string | null): void {
  if (expected !== null && readText(root, rel) === expected) {
    fs.rmSync(path.join(root, rel), { force: true })
  }
}

/** A workspace file's bytes, or null when there is no regular file of the workspace at `rel`. */
export function readBytes(root: string, rel: string): Buffer | null {
  const fd = openOwn(root, rel)
  if (fd === null) {
    return null
  }
  try {
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const withSuffix = (rel: string, n: number) => {
  if (n === 1) {
    return rel
  }
  const ext = path.extname(rel)
  return `${rel.slice(0, rel.length - ext.length)}-${String(n)}${ext}`
}

/** Links `src` in at `rel` or a free `rel-2`, `rel-3` beside it, never over a file; returns where. */
function linkFree(root: string, rel: string, src: string): string {
  for (let n = 1; ; n += 1) {
    const candidate = withSuffix(rel, n)
    try {
      fs.linkSync(src, path.join(root, candidate))
      return candidate
    } catch (e) {
      if (code(e) === 'EEXIST') {
        continue
      }
      if (code(e) !== 'EXDEV') {
        throw e
      }
    }
    try {
      fs.copyFileSync(src, path.join(root, candidate), fs.constants.COPYFILE_EXCL)
      return candidate
    } catch (e) {
      if (code(e) !== 'EEXIST') {
        throw e
      }
    }
  }
}

const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants
const FREE_NAMES_MAX = 1000

/** A new empty file at `rel` inside the workspace, or null when the name is taken. */
function createOwn(root: string, rel: string): number | null {
  let fd: number
  try {
    fd = fs.openSync(path.join(root, rel), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  } catch (e) {
    if (code(e) === 'EEXIST') {
      return null
    }
    throw e
  }
  if (inside(fd, root)) {
    return fd
  }
  const landed = fs.readlinkSync(`/proc/self/fd/${String(fd)}`)
  fs.closeSync(fd)
  fs.rmSync(landed, { force: true })
  throw new Error(`${rel} does not lead into the workspace`)
}

async function copyBytes(from: number, to: number, size: number): Promise<void> {
  if (size === 0) {
    return
  }
  await pipeline(
    fs.createReadStream('', { fd: from, start: 0, end: size - 1, autoClose: false }),
    fs.createWriteStream('', { fd: to, autoClose: false }),
  )
}

/**
 * Copies `size` bytes of an open file into the workspace at `rel`, or at a free `rel-2` beside
 * it, never over a file and never through a link planted in the way; returns where it landed.
 */
export async function copyInto(root: string, rel: string, from: number, size: number): Promise<string> {
  ownFolders(root, rel)
  for (let n = 1; n <= FREE_NAMES_MAX; n += 1) {
    const candidate = withSuffix(rel, n)
    const fd = createOwn(root, candidate)
    if (fd === null) {
      continue
    }
    try {
      await copyBytes(from, fd, size)
      return candidate
    } catch (e) {
      fs.rmSync(path.join(root, candidate), { force: true })
      throw e
    } finally {
      fs.closeSync(fd)
    }
  }
  throw new Error(`${rel} and the names beside it are taken`)
}

/** Moves a file Seti owns into the workspace under a free name next to `rel`; returns that name. */
export function moveInto(root: string, rel: string, src: string): string {
  ownFolders(root, rel)
  const placed = linkFree(root, rel, src)
  const fd = openOwn(root, placed)
  if (fd === null) {
    fs.rmSync(path.join(root, placed), { force: true })
    throw new Error(`${placed} does not lead into the workspace`)
  }
  fs.closeSync(fd)
  fs.rmSync(src, { force: true })
  return placed
}

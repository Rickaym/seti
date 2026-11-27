import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { binaryPath } from './binaries.js'
import { digestOf, download, holdsIntegrity, InstallError, onDisk, READ_AND_RUN } from './pinned-download.js'

/**
 * The Gemini CLI version Seti is built against: the npm tarball and its integrity, and the sha256
 * of its bundle folder as `treeDigest` reads it. The bundle is JavaScript, so one build serves
 * every platform that has Node.
 */
export const geminiPinSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  tarball: z.url({ protocol: /^https?$/ }),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
  bundle: z.string().regex(/^[0-9a-f]{64}$/),
})
export type GeminiPin = z.infer<typeof geminiPinSchema>

const BUNDLE = 'bundle'
const ENTRY = 'gemini.js'
const TARBALL = 'gemini-cli.tgz'
/** Files of an unpacked bundle: Seti's user reads them, nobody writes or runs them directly. */
const READ_ONLY = 0o400

export const versionDir = (root: string, version: string) => path.join(root, version)
/** The script Node runs to start Gemini CLI. */
export const entryIn = (root: string, version: string) => path.join(root, version, BUNDLE, ENTRY)
const stagingDir = (root: string, version: string) => path.join(root, `.staging-${version}`)

/** Every regular file under `dir` by its path relative to it; anything else is refused. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(dir, prefix), { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(dir, relative)))
    } else if (entry.isFile()) {
      found.push(relative)
    } else {
      throw new InstallError('checksum', `The Gemini CLI bundle holds ${relative}, which is not a plain file`)
    }
  }
  return found
}

/** Paths in code-point order, the same on every machine whatever its locale. */
const byPath = (a: string, b: string) => (a < b ? -1 : Number(a > b))

/**
 * One sha256 for a folder: over each regular file's relative path and sha256, in path order.
 * A folder holding a link or any other kind of entry has none.
 */
export async function treeDigest(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of (await filesUnder(dir)).sort(byPath)) {
    hash.update(`${file}\0${await digestOf(path.join(dir, file), 'sha256', 'hex')}\n`)
  }
  return hash.digest('hex')
}

/** Bundles already checked, by folder and what the stat of each file said then. */
const verified = new Map<string, string>()

/** Whether a version folder holds the pinned bundle; a check reads the files once as they stand. */
export async function holdsBundle(root: string, pin: GeminiPin): Promise<boolean> {
  const dir = path.join(versionDir(root, pin.version), BUNDLE)
  try {
    const files = (await filesUnder(dir)).sort(byPath)
    const stats = await Promise.all(files.map(async (file) => fs.promises.stat(path.join(dir, file))))
    const seen = [pin.bundle, ...stats.map((s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'))].join('|')
    if (verified.get(dir) === seen) {
      return true
    }
    verified.delete(dir)
    const matches = (await treeDigest(dir)) === pin.bundle
    if (matches) {
      verified.set(dir, seen)
    }
    return matches
  } catch {
    return false
  }
}

/** Unpacks the tarball's bundle folder into `to` with tar, given an argument list and no shell. */
async function unpack(tarball: string, to: string): Promise<void> {
  const program = binaryPath('tar')
  if (program === null) {
    throw new InstallError('platform', 'This machine has no tar program to unpack Gemini CLI with')
  }
  const args = ['-xzf', tarball, '-C', to, '--strip-components=1', '--no-same-owner', '--no-same-permissions']
  const tar = spawn(program, [...args, '--', `package/${BUNDLE}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  tar.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-500)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    tar.once('error', reject)
    tar.once('close', resolve)
  })
  if (code !== 0) {
    throw new InstallError('checksum', `The pinned tarball holds no ${BUNDLE} folder: ${stderr.trim()}`)
  }
}

/** Makes every file of the unpacked bundle read-only. */
async function lockFiles(dir: string): Promise<void> {
  for (const file of await filesUnder(dir)) {
    await fs.promises.chmod(path.join(dir, file), READ_ONLY)
  }
}

export interface GeminiFetchOptions {
  pin: GeminiPin
  /** The folder that holds one folder per version. */
  root: string
  /** Removes a folder of the root that holds a fetch that failed its checks. */
  discard: (dir: string) => Promise<void>
}

/** Fetches and checks the tarball, then unpacks and checks the bundle; returns where it lies. */
async function fetchInto(options: GeminiFetchOptions, staging: string): Promise<string> {
  const { pin } = options
  const tarball = path.join(staging, TARBALL)
  await download(pin.tarball, tarball)
  if (!(await holdsIntegrity(tarball, pin.integrity))) {
    await options.discard(staging)
    throw new InstallError('checksum', `The tarball from ${new URL(pin.tarball).host} fails its pinned sha512`)
  }
  const unpacked = path.join(staging, pin.version)
  if (fs.existsSync(unpacked)) {
    await options.discard(staging)
    throw new InstallError('disk', `An earlier unpack of Gemini CLI ${pin.version} was left in ${staging}`)
  }
  await fs.promises.mkdir(unpacked, { mode: 0o700 })
  await unpack(tarball, unpacked)
  if ((await treeDigest(path.join(unpacked, BUNDLE))) !== pin.bundle) {
    await options.discard(staging)
    throw new InstallError('checksum', 'The bundle in the tarball fails its pinned sha256')
  }
  await lockFiles(path.join(unpacked, BUNDLE))
  return unpacked
}

/**
 * Puts the pinned Gemini CLI at `<root>/<version>/bundle` unless it is there already: downloads
 * the tarball, checks its sha512 and the bundle's sha256 against the pin, and only then moves the
 * bundle into place, its files read-only and the version folder read and run only. A check that
 * fails discards what was fetched, so nothing unchecked ever runs.
 */
export async function fetchGemini(options: GeminiFetchOptions): Promise<{ entry: string; fetched: boolean }> {
  const { pin, root } = options
  const entry = entryIn(root, pin.version)
  if (await holdsBundle(root, pin)) {
    return { entry, fetched: false }
  }
  try {
    const dir = versionDir(root, pin.version)
    if (fs.existsSync(dir)) {
      await options.discard(dir)
    }
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    const staging = stagingDir(root, pin.version)
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 })
    const unpacked = await fetchInto(options, staging)
    await fs.promises.rename(unpacked, dir)
    await fs.promises.chmod(dir, READ_AND_RUN)
    await options.discard(staging)
  } catch (e) {
    throw onDisk(e)
  }
  return { entry, fetched: true }
}

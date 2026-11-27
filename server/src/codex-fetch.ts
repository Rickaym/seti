import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { binaryPath } from './binaries.js'
import { digestOf, download, holdsIntegrity, holdsSum, InstallError, onDisk, READ_AND_RUN } from './pinned-download.js'

const tarMember = z.string().regex(/^package(\/[\w.-]+)+$/)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * One platform's build: the registry tarball, its npm integrity, the binary in it and its sha256,
 * and the code mode host beside it, which runs the scripts newer models call their tools from.
 */
const platformPin = z.strictObject({
  tarball: z.url({ protocol: /^https?$/ }),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
  binary: tarMember,
  sha256: sha256Hex,
  host: z.strictObject({ member: tarMember, sha256: sha256Hex }),
})
type PlatformPin = z.infer<typeof platformPin>

/** The Codex version Seti is built against and where each platform's build comes from. */
export const codexPinSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platforms: z.record(z.string(), platformPin),
})
export type CodexPin = z.infer<typeof codexPinSchema>

/** The program's name in its version folder, and the code mode host's, which Codex finds beside. */
const PROGRAM = 'codex'
const HOST = 'codex-code-mode-host'
const TARBALL = 'codex.tgz'

export const versionDir = (root: string, version: string) => path.join(root, version)
export const programIn = (root: string, version: string) => path.join(root, version, PROGRAM)
const hostIn = (root: string, version: string) => path.join(root, version, HOST)
/** Where a version downloads and unpacks before it moves into place, kept to resume. */
export const stagingDir = (root: string, version: string) => path.join(root, `.staging-${version}`)

/** This machine's build in the pin, or a refusal when the pin names none. */
export function platformOf(pin: CodexPin) {
  const key = `${process.platform}-${process.arch}`
  const build = pin.platforms[key]
  if (build === undefined) {
    throw new InstallError('platform', `Codex ${pin.version} has no build for ${key}`)
  }
  return build
}

/** Whether a version folder holds the build's program and code mode host, each with its sha256. */
export async function holdsBuild(root: string, version: string, build: PlatformPin): Promise<boolean> {
  return (await holdsSum(programIn(root, version), build.sha256)) && holdsSum(hostIn(root, version), build.host.sha256)
}

/** Unpacks one member of the tarball into `to` with tar, given an argument list and no shell. */
async function unpack(tarball: string, member: string, to: string): Promise<void> {
  const program = binaryPath('tar')
  if (program === null) {
    throw new InstallError('platform', 'This machine has no tar program to unpack Codex with')
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
    throw new InstallError('checksum', `The pinned tarball holds no ${member}: ${stderr.trim()}`)
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
  if (!(await holdsIntegrity(tarball, build.integrity))) {
    await options.discard(staging)
    throw new InstallError('checksum', `The tarball from ${new URL(build.tarball).host} fails its pinned sha512`)
  }
  const unpacked = path.join(staging, pin.version)
  const stat = await fs.promises.stat(unpacked).catch(() => null)
  if (stat !== null) {
    await fs.promises.chmod(unpacked, 0o700)
  }
  await fs.promises.mkdir(unpacked, { recursive: true, mode: 0o700 })
  const files = [
    { file: path.join(unpacked, PROGRAM), from: build.binary, sum: build.sha256, what: 'program' },
    { file: path.join(unpacked, HOST), from: build.host.member, sum: build.host.sha256, what: 'code mode host' },
  ]
  for (const { file, from, sum, what } of files) {
    await unpack(tarball, from, file)
    if ((await digestOf(file, 'sha256', 'hex')) !== sum) {
      await options.discard(staging)
      throw new InstallError('checksum', `The ${what} in the tarball fails its pinned sha256`)
    }
  }
  return unpacked
}

/**
 * Puts the pinned Codex at `<root>/<version>/codex` unless it is there already: downloads the
 * tarball, checks its sha512 and the program's and code mode host's sha256 against the pin, and
 * only then moves a folder holding those two alone into place, folder and files read and run
 * only. A check that fails discards what was fetched, so nothing unchecked ever runs.
 */
export async function fetchPinned(options: FetchOptions): Promise<{ program: string; fetched: boolean }> {
  const { pin, root } = options
  const build = platformOf(pin)
  const program = programIn(root, pin.version)
  if (await holdsBuild(root, pin.version, build)) {
    return { program, fetched: false }
  }
  try {
    await dropChanged(options)
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    const staging = stagingDir(root, pin.version)
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 })
    const unpacked = await fetchInto(options, staging)
    await fs.promises.chmod(path.join(unpacked, PROGRAM), READ_AND_RUN)
    await fs.promises.chmod(path.join(unpacked, HOST), READ_AND_RUN)
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
  const files = [PROGRAM, HOST, TARBALL].map((name) => path.join(dir, name))
  for (const file of [...files, path.join(inner, PROGRAM), path.join(inner, HOST)]) {
    await fs.promises.rm(file, { force: true })
  }
  await fs.promises.rmdir(inner).catch(() => undefined)
  await fs.promises.rmdir(dir)
}

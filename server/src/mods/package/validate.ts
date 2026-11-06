import path from 'node:path'
import {
  MOD_PACKAGE_LIMITS,
  isIconFile,
  manifestProblem,
  modDocFiles,
  modManifest,
  type ModManifest,
} from '@seti/shared'
import { logicProblem, pageScripts, textOf } from './files.js'
import { packageHash } from './hash.js'
import { iconData } from './icon.js'
import { themeTokensCss } from '../theme-tokens.js'

/** Why Seti refuses a package, in words the user reads on the consent screen. */
export class PackageProblem extends Error {}

/** Reads one file of a package by its relative path, at most `max` bytes plus one; null if absent. */
export type PackageReader = (relative: string, max: number) => Promise<Buffer | null>

/** A package Seti read and checked: only the files it uses, its hash and its pages' script hashes. */
export interface ValidPackage {
  manifest: ModManifest
  files: Map<string, Buffer>
  hash: string
  size: number
  /** Each page's inline script hashes, for its hash-pinned page policy. */
  scriptHashes: Record<string, string[]>
}

const MANIFEST_FILE = 'seti-mod.json'

const KB = 1024

/** Why a path in the manifest cannot name a file of the package, or null when it can. */
function packagePathProblem(relative: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(relative) || relative.includes('\\')) {
    return `${relative} must be plain ASCII with / between folders`
  }
  if (relative.startsWith('/') || path.posix.normalize(relative) !== relative || relative.startsWith('./')) {
    return `${relative} must be a relative path with no . or .. parts`
  }
  if (relative.split('/').some((part) => part === '..' || part === '' || part === '.')) {
    return `${relative} must stay inside the package`
  }
  return relative.split('/').includes('node_modules')
    ? `${relative} is inside node_modules, which Seti never reads`
    : null
}

const fail = (message: string): never => {
  throw new PackageProblem(message)
}

async function readCapped(read: PackageReader, relative: string, max: number, required: boolean) {
  const bytes = await read(relative, max)
  if (bytes === null) {
    return required ? fail(`${relative} is missing from the package`) : null
  }
  return bytes.length > max ? fail(`${relative} is over ${String(max / KB)} KB`) : bytes
}

function parseManifest(bytes: Buffer, bundledIds: ReadonlySet<string>): ModManifest {
  const text = textOf(bytes) ?? fail(`${MANIFEST_FILE} is not UTF-8 text`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail(`${MANIFEST_FILE} is not valid JSON`)
  }
  const parsed = modManifest.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(`${MANIFEST_FILE} is not valid: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`)
  }
  const problem = manifestProblem(parsed.data, 'third-party', bundledIds)
  return problem === null ? parsed.data : fail(problem)
}

/** The files the manifest names: its logic bundle, its pages and its icon. */
function listedFiles(manifest: ModManifest): { main: string | null; pages: string[]; icon: string | null } {
  const pages = [...manifest.contributes.views, ...manifest.contributes.fileViewers].flatMap((page) =>
    page.entry === undefined ? [] : [page.entry],
  )
  const unique = [...new Set(pages)]
  if (unique.length > MOD_PACKAGE_LIMITS.pages) {
    fail(`A package has at most ${String(MOD_PACKAGE_LIMITS.pages)} pages`)
  }
  const icon = manifest.icon !== undefined && isIconFile(manifest.icon) ? manifest.icon : null
  for (const relative of [manifest.main, ...unique, icon ?? undefined, manifest.readme, manifest.changelog]) {
    const problem = relative === undefined ? null : packagePathProblem(relative)
    if (problem !== null) {
      fail(problem)
    }
  }
  return { main: manifest.main ?? null, pages: unique, icon }
}

/** The Markdown files and licence a package shows; a file the manifest names must be there. */
async function readDocs(read: PackageReader, manifest: ModManifest, files: Map<string, Buffer>): Promise<void> {
  const docs = modDocFiles(manifest)
  const named = new Set([manifest.readme, manifest.changelog])
  for (const doc of new Set([docs.readme, docs.changelog, 'LICENSE'])) {
    const bytes = await readCapped(read, doc, MOD_PACKAGE_LIMITS.docBytes, named.has(doc))
    if (bytes !== null) {
      files.set(doc, textOf(bytes) === null ? fail(`${doc} is not UTF-8 text`) : bytes)
    }
  }
}

async function readIcon(read: PackageReader, icon: string, files: Map<string, Buffer>): Promise<void> {
  const bytes = (await readCapped(read, icon, MOD_PACKAGE_LIMITS.iconBytes, true)) ?? Buffer.alloc(0)
  const checked = iconData(icon, bytes)
  files.set(icon, 'problem' in checked ? fail(checked.problem) : bytes)
}

/** Reads each theme's token file, which must pass Seti's token rules. */
async function readThemes(read: PackageReader, manifest: ModManifest, files: Map<string, Buffer>): Promise<void> {
  for (const theme of manifest.contributes.themes) {
    const bytes = (await readCapped(read, theme.tokens, MOD_PACKAGE_LIMITS.docBytes, true)) ?? Buffer.alloc(0)
    const checked = themeTokensCss(manifest.id, theme, textOf(bytes) ?? fail(`${theme.tokens} is not UTF-8 text`))
    files.set(theme.tokens, 'problem' in checked ? fail(checked.problem) : bytes)
  }
}

/**
 * Reads a package through `read`, which applies its source's own rules (no symlinks, no links
 * out of the tree), and checks everything Seti will serve or run; throws PackageProblem if not.
 */
export async function readPackage(read: PackageReader, bundledIds: ReadonlySet<string>): Promise<ValidPackage> {
  const limits = MOD_PACKAGE_LIMITS
  const manifestBytes = await readCapped(read, MANIFEST_FILE, limits.manifestBytes, true)
  const manifest = parseManifest(manifestBytes ?? Buffer.alloc(0), bundledIds)
  const files = new Map<string, Buffer>([[MANIFEST_FILE, manifestBytes ?? Buffer.alloc(0)]])
  const { main, pages, icon } = listedFiles(manifest)
  if (main !== null) {
    const bytes = (await readCapped(read, main, limits.logicBytes, true)) ?? Buffer.alloc(0)
    const problem = logicProblem(main, textOf(bytes) ?? fail(`${main} is not UTF-8 text`))
    files.set(main, problem === null ? bytes : fail(problem))
  }
  const scriptHashes: Record<string, string[]> = {}
  for (const page of pages) {
    const bytes = (await readCapped(read, page, limits.pageBytes, true)) ?? Buffer.alloc(0)
    const scripts = pageScripts(page, textOf(bytes) ?? fail(`${page} is not UTF-8 text`))
    scriptHashes[page] = 'problem' in scripts ? fail(scripts.problem) : scripts.hashes
    files.set(page, bytes)
  }
  if (icon !== null) {
    await readIcon(read, icon, files)
  }
  await readThemes(read, manifest, files)
  await readDocs(read, manifest, files)
  const size = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)
  if (size > limits.totalBytes) {
    fail(
      `A package is at most ${String(limits.totalBytes / KB / KB)} MB; this one is ${String(Math.ceil(size / KB))} KB`,
    )
  }
  return { manifest, files, hash: packageHash(files), size, scriptHashes }
}

/** A reader over files already in memory, as a stored version holds them. */
export const mapReader =
  (files: ReadonlyMap<string, Buffer>): PackageReader =>
  async (relative) =>
    Promise.resolve(files.get(relative) ?? null)

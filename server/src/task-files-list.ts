import fs from 'node:fs'
import path from 'node:path'
import {
  FILE_LIST_MAX,
  NOISE_DIRS,
  type FileEntry,
  type FileListing,
  type FileListQuery,
  type RecentFile,
  type RecentFiles,
  type ResolvedPath,
} from '@seti/shared'
import { HttpError } from './http.js'
import {
  inNestedRoot,
  isSetiFile,
  locate,
  openRoots,
  pathProblem,
  realOr,
  within,
  type FileContext,
  type Located,
  type OpenRoot,
} from './task-files.js'
import { WORKSPACE_ROOT } from './workspace/dir.js'

interface Listed {
  dir: string
  rel: string
  root: OpenRoot
  files: FileContext
  /** Leave out the files Seti writes into the workspace. */
  hideSeti: boolean
}

/** One entry of a folder, following links that stay in the root; null for what is not shown. */
function entryOf(dirent: fs.Dirent, { dir, rel, root, files, hideSeti }: Listed): FileEntry | null {
  const full = path.join(dir, dirent.name)
  let real = full
  if (dirent.isSymbolicLink()) {
    try {
      real = fs.realpathSync(full)
    } catch {
      return null
    }
  }
  if (
    !within(real, root.real) ||
    pathProblem(real, files.rules) !== null ||
    (hideSeti && isSetiFile(real, files.rules))
  ) {
    return null
  }
  const stat = fs.statSync(real, { throwIfNoEntry: false })
  if (stat === undefined || !(stat.isFile() || stat.isDirectory())) {
    return null
  }
  const isDir = stat.isDirectory()
  return {
    name: dirent.name,
    path: rel === '' ? dirent.name : `${rel}/${dirent.name}`,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : stat.size,
    mtime: stat.mtime.toISOString(),
  }
}

const sameName = (a: FileEntry, b: FileEntry) =>
  a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })

function byRecent(a: FileEntry, b: FileEntry): number {
  const order = b.mtime.localeCompare(a.mtime)
  return order === 0 ? sameName(a, b) : order
}

/** Folders first, then by name as people sort them: numbers in order, case aside. */
function byName(a: FileEntry, b: FileEntry): number {
  if (a.type === b.type) {
    return sameName(a, b)
  }
  return a.type === 'dir' ? -1 : 1
}

type ListOptions = Pick<FileListQuery, 'sort' | 'dotfiles' | 'seti_files'>

/** A folder's entries; Seti's own files stay out unless asked for or the folder is one of them. */
export function listDir(at: Located, files: FileContext, { sort, dotfiles, seti_files }: ListOptions): FileListing {
  const dir = at.real
  if (dir === null || fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new HttpError(400, `${at.rel === '' ? at.root.label : at.rel} is not a folder`)
  }
  const hideSeti = !seti_files && !isSetiFile(dir, files.rules)
  const listed: Listed = { dir, rel: at.rel, root: at.root, files, hideSeti }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dotfiles || !dirent.name.startsWith('.'))
    .flatMap((dirent) => entryOf(dirent, listed) ?? [])
    .toSorted(sort === 'recent' ? byRecent : byName)
  return {
    root: at.root.id,
    path: at.rel,
    entries: entries.slice(0, FILE_LIST_MAX),
    truncated: entries.length > FILE_LIST_MAX,
  }
}

const NOISE = new Set<string>(NOISE_DIRS)

/** Entries one root's walk visits at most, so a huge checkout cannot stall the request. */
const WALK_MAX = 20_000
const WALK_DEPTH = 8

interface Folder {
  dir: string
  rel: string
  depth: number
}

interface Walked {
  files: RecentFile[]
  truncated: boolean
}

function readFolder(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

interface Walk {
  root: OpenRoot
  /** Every open root, so a nested root's files are left to that root. */
  roots: readonly OpenRoot[]
  files: FileContext
  since: number
  hideSeti: boolean
  found: RecentFile[]
  queue: Folder[]
}

/** Whether the walk leaves a path to another root, to the hidden Seti files, or out entirely. */
const skipped = (walk: Walk, real: string) =>
  pathProblem(real, walk.files.rules) !== null ||
  inNestedRoot(real, walk.root, walk.roots) ||
  (walk.hideSeti && isSetiFile(real, walk.files.rules))

/** Queues a folder worth walking into, or records a file changed since the walk's cutoff. */
function visit(walk: Walk, folder: Folder, dirent: fs.Dirent): void {
  const child: Folder = {
    dir: path.join(folder.dir, dirent.name),
    rel: folder.rel === '' ? dirent.name : `${folder.rel}/${dirent.name}`,
    depth: folder.depth + 1,
  }
  if (skipped(walk, child.dir)) {
    return
  }
  if (dirent.isDirectory()) {
    if (!NOISE.has(dirent.name) && child.depth <= WALK_DEPTH) {
      walk.queue.push(child)
    }
    return
  }
  const stat = dirent.isFile() ? fs.statSync(child.dir, { throwIfNoEntry: false }) : undefined
  if (stat !== undefined && stat.mtimeMs >= walk.since) {
    const { size, mtime } = stat
    walk.found.push({
      root: walk.root.id,
      name: dirent.name,
      path: child.rel,
      type: 'file',
      size,
      mtime: mtime.toISOString(),
    })
  }
}

/** Files of one root changed since `since`, breadth first, past no dot, noise or hidden folder. */
function walkRoot(walk: Walk): Walked {
  let visited = 0
  for (let folder = walk.queue.shift(); folder !== undefined; folder = walk.queue.shift()) {
    const dirents = readFolder(folder.dir).filter((d) => !d.name.startsWith('.') && !d.isSymbolicLink())
    visited += dirents.length
    if (visited > WALK_MAX) {
      return { files: walk.found, truncated: true }
    }
    for (const dirent of dirents) {
      visit(walk, folder, dirent)
    }
  }
  return { files: walk.found, truncated: false }
}

interface RecentOptions {
  since: Date
  limit: number
  /** Include the files Seti writes into the workspace. */
  setiFiles: boolean
}

/**
 * The newest files across the task's roots changed since `since`, skipping dot and noise folders.
 * Each file shows once, under the innermost root that holds it.
 */
export function recentFiles(files: FileContext, { since, limit, setiFiles }: RecentOptions): RecentFiles {
  const roots = openRoots(files)
  const walks = roots.map((root) =>
    walkRoot({
      root,
      roots,
      files,
      since: since.getTime(),
      hideSeti: !setiFiles,
      found: [],
      queue: [{ dir: root.real, rel: '', depth: 0 }],
    }),
  )
  return {
    files: walks
      .flatMap((walk) => walk.files)
      .toSorted(byRecent)
      .slice(0, limit),
    since: since.toISOString(),
    truncated: walks.some((walk) => walk.truncated),
  }
}

const expandHome = (raw: string, home: string) => (raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw)

interface Candidate {
  root: string
  rel: string
}

/** Every root and relative path an absolute path could be, through the root as named or as real. */
function absoluteCandidates(files: FileContext, absolute: string): Candidate[] {
  return files.roots.flatMap((root) =>
    [...new Set([root.path, root.real ?? root.path])]
      .filter((base) => within(absolute, base))
      .map((base) => ({ root: root.id, rel: path.relative(base, absolute) })),
  )
}

function locateExisting(files: FileContext, candidate: Candidate): Located | null {
  try {
    const at = locate(files, candidate.root, candidate.rel)
    return at.real === null || at.rel === '' ? null : at
  } catch {
    return null
  }
}

/** The id of the task whose workspace holds an absolute path, by its folder name; else null. */
export function workspaceOwner(raw: string, home: string): string | null {
  const expanded = path.normalize(expandHome(raw.trim(), home))
  for (const base of new Set([WORKSPACE_ROOT, realOr(WORKSPACE_ROOT)])) {
    const [owner = ''] = path.relative(base, expanded).split(path.sep)
    if (path.isAbsolute(expanded) && within(expanded, base) && owner !== '') {
      return owner
    }
  }
  return null
}

/** The first candidate that exists, with a file's size and last change. */
function firstExisting(files: FileContext, raw: string, candidates: readonly Candidate[]): ResolvedPath | null {
  for (const candidate of candidates) {
    const at = locateExisting(files, candidate)
    const real = at?.real ?? null
    const stat = real === null ? undefined : fs.statSync(real, { throwIfNoEntry: false })
    if (at !== null && stat !== undefined) {
      const found = { input: raw, root: at.root.id, path: at.rel }
      return stat.isDirectory()
        ? { ...found, type: 'dir' }
        : { ...found, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() }
    }
  }
  return null
}

/** Which root holds a path an agent mentioned: absolute inside a root, or relative to one. */
export function resolvePath(files: FileContext, raw: string, home: string): ResolvedPath | null {
  const expanded = expandHome(raw.trim(), home)
  const candidates = path.isAbsolute(expanded)
    ? absoluteCandidates(files, expanded)
    : files.roots.filter((root) => root.real !== null).map((root) => ({ root: root.id, rel: expanded }))
  return firstExisting(files, raw, candidates)
}

/** The file a Files link names by root and path, when it exists. */
export function resolveLinked(files: FileContext, raw: string, root: string, rel: string): ResolvedPath | null {
  return firstExisting(files, raw, [{ root, rel }])
}

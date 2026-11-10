import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  extraDirs,
  FILE_TEXT_MAX,
  isTextKind,
  kindByName,
  type FileKind,
  type FileMeta,
  type FileRoot,
  type FileStamp,
  type SandboxPolicy,
  type Task,
} from '@seti/shared'
import { CLAUDE_HOME, WORKTREE_ROOT } from './config.js'
import { contentType } from './content-type.js'
import { fromEa } from './ea-guard.js'
import { HttpError } from './http.js'
import { filesHiddenPaths, setiHomePaths, type SandboxContext } from './sandbox.js'
import { CHAT, SECRETS, SETI_FILES, workspaceDir } from './workspace/dir.js'

/** What decides which paths of a task the Files view serves. */
export interface FileRules {
  /** Absolute paths and globs never served, dot files opted in or not. */
  hidden: readonly string[]
  setiHomes: readonly string[]
  worktreeRoot: string
  claudeHome: string
  /** The task's own workspace, the one part of Seti's home besides worktrees that opens. */
  workspace: string
}

export interface TaskRoot extends FileRoot {
  /** The real path of an existing root, or null when it is gone or refused. */
  real: string | null
}

export type OpenRoot = TaskRoot & { real: string }

export interface FileContext {
  task: Task
  rules: FileRules
  roots: TaskRoot[]
}

export const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)

const isGlob = (entry: string) => /[*?[]/.test(entry)

export const realOr = (file: string) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/** The rules for one task, with each path also as its real path so symlinked homes still match. */
export function fileRules(taskId: string, policy: SandboxPolicy, ctx: SandboxContext): FileRules {
  const both = (entries: readonly string[]) => [
    ...new Set(entries.flatMap((entry) => (isGlob(entry) ? [entry] : [entry, realOr(entry)]))),
  ]
  return {
    hidden: both(filesHiddenPaths(policy, ctx)),
    setiHomes: both(setiHomePaths(ctx)),
    worktreeRoot: realOr(WORKTREE_ROOT),
    claudeHome: realOr(CLAUDE_HOME),
    workspace: realOr(workspaceDir(taskId)),
  }
}

const matchesHidden = (real: string, entry: string) =>
  isGlob(entry) ? path.matchesGlob(real, entry) || path.matchesGlob(real, `${entry}/**`) : within(real, entry)

/** Whether a path, real or as named, matches a hidden path or glob. */
export const isHidden = (file: string, rules: FileRules) => rules.hidden.some((entry) => matchesHidden(file, entry))

/** Why a real path is never served, or null when it may be. */
export function pathProblem(real: string, rules: FileRules): string | null {
  if (isHidden(real, rules)) {
    return 'is a hidden path'
  }
  if (within(real, rules.claudeHome)) {
    return "is part of Claude Code's own data"
  }
  if (within(real, path.join(rules.workspace, SECRETS))) {
    return 'holds secrets the user gave the agent, which Seti never serves'
  }
  if (fromEa() && real === path.join(rules.workspace, CHAT)) {
    return "is the agent's chat.md, which holds its direct messages; read the group chat instead"
  }
  const setiData = rules.setiHomes.some((home) => within(real, home))
  const ownPart = within(real, rules.workspace) || (within(real, rules.worktreeRoot) && real !== rules.worktreeRoot)
  if (setiData && !ownPart) {
    return "is part of Seti's own data"
  }
  return null
}

/** Whether a real path is a file or folder Seti writes into the task's workspace and rewrites. */
export function isSetiFile(real: string, rules: FileRules): boolean {
  if (real === rules.workspace || !within(real, rules.workspace)) {
    return false
  }
  const [top = ''] = path.relative(rules.workspace, real).split(path.sep)
  return SETI_FILES.includes(top)
}

const hasDotSegment = (rel: string) => rel.split(path.sep).some((part) => part.startsWith('.'))

const rootId = (dir: string) => `dir-${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`

type RootSpec = Pick<FileRoot, 'id' | 'label' | 'path' | 'kind'>

function rootOf(spec: RootSpec, rules: FileRules): TaskRoot {
  const exists = fs.statSync(spec.path, { throwIfNoEntry: false })?.isDirectory() === true
  const real = exists ? fs.realpathSync(spec.path) : null
  const allowed = real !== null && pathProblem(real, rules) === null
  return { ...spec, exists: allowed, writable: spec.kind !== 'workspace', real: allowed ? real : null }
}

/** The task's working directory, its other repos and directories, and its Seti workspace. */
export function taskRoots(task: Task, rules: FileRules): TaskRoot[] {
  const spec = (dir: string, id: string, fallback: TaskRoot['kind']): RootSpec => {
    const slug = task.repos.find((repo) => repo.dir === dir)?.slug
    return { id, label: slug ?? path.basename(dir), path: dir, kind: slug === undefined ? fallback : 'repo' }
  }
  return [
    rootOf(spec(task.cwd, 'cwd', 'cwd'), rules),
    ...extraDirs(task).map((dir) => rootOf(spec(dir, rootId(dir), 'dir'), rules)),
    rootOf({ id: 'workspace', label: 'Workspace', path: workspaceDir(task.id), kind: 'workspace' }, rules),
  ]
}

export function publicRoot(root: TaskRoot): FileRoot {
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    kind: root.kind,
    exists: root.exists,
    writable: root.writable,
  }
}

/** The roots that exist, each real folder once, the first root naming it kept. */
export function openRoots(files: FileContext): OpenRoot[] {
  const seen = new Set<string>()
  return files.roots.flatMap((root) => {
    if (root.real === null || seen.has(root.real)) {
      return []
    }
    seen.add(root.real)
    return [{ ...root, real: root.real }]
  })
}

/** Whether a real path under `root` lies inside another, nested root, which shows it instead. */
export function inNestedRoot(real: string, root: OpenRoot, roots: readonly OpenRoot[]): boolean {
  return roots.some(
    (other) =>
      other.real !== root.real && within(other.real, root.real) && real !== other.real && within(real, other.real),
  )
}

function findRoot(files: FileContext, id: string): OpenRoot {
  const root = files.roots.find((entry) => entry.id === id)
  if (root === undefined) {
    throw new HttpError(404, `No root ${id} for this agent`)
  }
  if (root.real === null) {
    throw new HttpError(404, `${root.path} is not available`)
  }
  return { ...root, real: root.real }
}

/** A path inside a root, checked; `real` is null for a file that does not exist yet. */
export interface Located {
  root: OpenRoot
  /** Relative to the root, with forward slashes; empty for the root itself. */
  rel: string
  real: string | null
  /** The real directory that holds the file; for a missing file it may not exist yet. */
  parent: string
}

function cleanRel(raw: string): string {
  if (raw.includes('\0')) {
    throw new HttpError(400, 'Paths cannot hold NUL bytes')
  }
  if (path.isAbsolute(raw)) {
    throw new HttpError(400, 'Give a path relative to the root')
  }
  const parts = path
    .normalize(raw === '' ? '.' : raw)
    .split(path.sep)
    .filter((part) => part !== '' && part !== '.')
  if (parts[0] === '..') {
    throw new HttpError(403, `${raw} leads outside its root`)
  }
  return parts.join(path.sep)
}

interface Check {
  root: OpenRoot
  rel: string
  rules: FileRules
  dotfiles: boolean
}

function refuseReal(real: string, { root, rel, rules, dotfiles }: Check): void {
  if (!within(real, root.real)) {
    throw new HttpError(403, `${rel} leads outside its root`)
  }
  const problem = pathProblem(real, rules)
  if (problem !== null) {
    throw new HttpError(403, `${rel} ${problem}`)
  }
  if (!dotfiles && hasDotSegment(path.relative(root.real, real))) {
    throw new HttpError(403, `${rel} is a dot file; show dot files to open it`)
  }
}

/** Where a new file lands: its nearest existing folder resolved, with the missing part after it. */
function missingTarget(lexical: string): { existing: string; file: string } {
  let dir = path.dirname(lexical)
  while (fs.lstatSync(dir, { throwIfNoEntry: false }) === undefined) {
    dir = path.dirname(dir)
  }
  const existing = realOr(dir)
  if (fs.statSync(existing, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new HttpError(400, `${path.basename(dir)} is not a folder`)
  }
  return { existing, file: path.join(existing, path.relative(dir, lexical)) }
}

function realOrMissing(lexical: string, allowMissing: boolean, rel: string): string | null {
  try {
    return fs.realpathSync(lexical)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing || rel === '') {
      throw new HttpError(404, `${rel} does not exist`)
    }
  }
  if (fs.lstatSync(lexical, { throwIfNoEntry: false }) !== undefined) {
    throw new HttpError(403, `${rel} is a broken link`)
  }
  return null
}

export interface LocateOptions {
  dotfiles?: boolean
  /** Accept a file that does not exist yet, for creating it. */
  missing?: boolean
}

/** Resolves a path in a root through its symlinks and refuses what the rules keep out. */
export function locate(files: FileContext, rootIdValue: string, raw: string, options: LocateOptions = {}): Located {
  const root = findRoot(files, rootIdValue)
  const rel = cleanRel(raw)
  const check: Check = { root, rel, rules: files.rules, dotfiles: options.dotfiles === true }
  if (!check.dotfiles && hasDotSegment(rel)) {
    throw new HttpError(403, `${rel} is a dot file; show dot files to open it`)
  }
  const lexical = path.join(root.real, rel)
  const posix = rel.split(path.sep).join('/')
  const real = realOrMissing(lexical, options.missing === true, rel)
  if (real !== null) {
    refuseReal(real, check)
    return { root, rel: posix, real, parent: path.dirname(real) }
  }
  const target = missingTarget(lexical)
  refuseReal(target.existing, check)
  refuseReal(target.file, check)
  return { root, rel: posix, real: null, parent: path.dirname(target.file) }
}

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants

/** Opens a regular file whose real path is `real`, never a FIFO or a link swapped in since. */
export function openChecked(real: string): number {
  const fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new HttpError(400, `${path.basename(real)} is not a regular file`)
    }
    if (fs.readlinkSync(`/proc/self/fd/${String(fd)}`) !== real) {
      throw new HttpError(409, `${path.basename(real)} moved while it was opened`)
    }
    return fd
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

function readAll(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const got = fs.readSync(fd, buffer, read, size - read, read)
    if (got === 0) {
      break
    }
    read += got
  }
  return buffer.subarray(0, read)
}

const SNIFF_BYTES = 8192

/** Text is valid UTF-8 with no NUL byte in its first few kilobytes. */
export function looksLikeText(sample: Buffer): boolean {
  if (sample.includes(0)) {
    return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
    return true
  } catch {
    return false
  }
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

function kindOf(name: string, fd: number, size: number): FileKind {
  const named = kindByName(name)
  if (named !== null) {
    return named
  }
  return looksLikeText(readAll(fd, Math.min(size, SNIFF_BYTES))) ? 'text' : 'binary'
}

export interface ReadResult {
  meta: FileMeta
  /** The content of a text file within the editor's cap, when asked for; else null. */
  text: string | null
}

/** A file's metadata, and its text when `withText` and it is a text file within the cap. */
export function readFile(at: Located, withText: boolean): ReadResult {
  if (at.real === null) {
    throw new HttpError(404, `${at.rel} does not exist`)
  }
  const fd = openChecked(at.real)
  try {
    const stat = fs.fstatSync(fd)
    const name = path.basename(at.rel)
    const kind = kindOf(name, fd, stat.size)
    const small = isTextKind(kind) && stat.size <= FILE_TEXT_MAX
    const bytes = small ? readAll(fd, stat.size) : null
    const meta: FileMeta = {
      root: at.root.id,
      path: at.rel,
      name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind,
      content_type: contentType(name, kind),
      hash: bytes === null ? null : sha256(bytes),
      writable: at.root.writable && small,
    }
    return { meta, text: withText && bytes !== null ? bytes.toString('utf8') : null }
  } finally {
    fs.closeSync(fd)
  }
}

const GONE: FileStamp = { exists: false, size: 0, mtime: null, hash: null }

/** The file's state for the change stream; a missing or refused file reads as gone. */
export function stampOf(files: FileContext, at: Located, dotfiles: boolean): FileStamp {
  try {
    const { meta } = readFile(locate(files, at.root.id, at.rel, { dotfiles }), false)
    return { exists: true, size: meta.size, mtime: meta.mtime, hash: meta.hash }
  } catch {
    return GONE
  }
}

/** The save refused because the file changed since the editor loaded it. */
export class FileConflictError extends Error {
  readonly current: FileStamp

  constructor(current: FileStamp) {
    super('The file changed on disk since you opened it')
    this.current = current
  }
}

function writeNew(parent: string, name: string, text: string): void {
  fs.mkdirSync(parent, { recursive: true })
  if (fs.realpathSync(parent) !== parent) {
    throw new HttpError(409, `The folder of ${name} moved while it was created`)
  }
  const fd = fs.openSync(path.join(parent, name), 'wx', 0o644)
  try {
    fs.writeFileSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}

/** Swaps the file for one holding `text`, keeping its mode; readers never see half a file. */
function replace(real: string, text: string): void {
  const mode = fs.statSync(real).mode & 0o7777
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${randomUUID()}.seti-tmp`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, text)
    fs.fchmodSync(fd, mode)
    fs.closeSync(fd)
    fs.renameSync(tmp, real)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export interface SaveRequest {
  text: string
  baseHash: string | null
  dotfiles: boolean
}

function create(files: FileContext, at: Located, save: SaveRequest): void {
  if (save.baseHash !== null) {
    throw new FileConflictError(GONE)
  }
  try {
    writeNew(at.parent, path.basename(at.rel), save.text)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileConflictError(stampOf(files, at, save.dotfiles))
    }
    throw e
  }
}

/** Saves a text file when it still holds what the editor loaded; a null base creates it. */
export function saveText(files: FileContext, at: Located, save: SaveRequest): { created: boolean; bytes: number } {
  if (!at.root.writable) {
    throw new HttpError(403, `${at.root.label} is read-only here`)
  }
  const bytes = Buffer.byteLength(save.text)
  if (bytes > FILE_TEXT_MAX) {
    throw new HttpError(413, 'The text is larger than the editor saves')
  }
  if (at.real === null) {
    create(files, at, save)
    return { created: true, bytes }
  }
  const { meta } = readFile(at, false)
  if (!isTextKind(meta.kind) || meta.hash === null) {
    throw new HttpError(415, `${at.rel} is not a text file the editor can save`)
  }
  if (save.baseHash !== meta.hash) {
    throw new FileConflictError({ exists: true, size: meta.size, mtime: meta.mtime, hash: meta.hash })
  }
  replace(at.real, save.text)
  return { created: false, bytes }
}

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { ArchivedFolder, RestoredFolder, Task, TaskFilesBundle } from '@seti/shared'
import { audit } from './audit.js'
import { binaryPath } from './binaries.js'
import { ARCHIVE_ROOT } from './config.js'
import { now, tasks } from './db.js'
import { directoryBytes, removeWorktree } from './git.js'
import { busyReason, OWNED_ROOTS, removalRefusal, removeOwnedDir, scratchDirOf, type OwnedRoot } from './owned-dirs.js'
import { taskArchives } from './store/archive.js'
import { taskLocation } from './store/task-location.js'
import { inLane } from './task-lane.js'
import { removeTaskSandbox } from './task-sandbox.js'
import { releaseWorkspace, workspaceDir } from './workspace/dir.js'

/** Dependencies, virtualenvs, build outputs and caches, which a reinstall or build remakes. */
const BUNDLE_EXCLUDES = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.cache',
  '.pnpm-store',
  'dist',
  'build',
  'target',
  'coverage',
] as const

const ZSTD_LEVEL = 6

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const bundleDir = (taskId: string) => path.join(ARCHIVE_ROOT, taskId)
export const patchesDir = (taskId: string) => path.join(bundleDir(taskId), 'patches')

/** One bundle per archiving, named for its time, so a leftover never stands in for another. */
const bundleFile = (taskId: string, archivedAt: string) =>
  path.join(bundleDir(taskId), `files-${archivedAt.replace(/\D/g, '')}.tar.zst`)

const ROOT_OF: Record<ArchivedFolder['kind'], OwnedRoot> = { scratch: 'scratch', workspace: 'workspace' }

interface Source {
  kind: ArchivedFolder['kind']
  dir: string
}

/** The folders Seti made for the task that are on disk now: its scratch folder and workspace. */
function sourcesOf(task: Task): Source[] {
  const scratch = scratchDirOf(task)
  const sources: Source[] = []
  if (scratch !== null && fs.existsSync(scratch)) {
    sources.push({ kind: 'scratch', dir: scratch })
  }
  if (fs.existsSync(workspaceDir(task.id))) {
    sources.push({ kind: 'workspace', dir: workspaceDir(task.id) })
  }
  return sources
}

/** Makes the task's bundle folder, refusing one that is not a plain folder in the archive root. */
export function ensureBundleDir(taskId: string): string {
  const dir = bundleDir(taskId)
  fs.mkdirSync(ARCHIVE_ROOT, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700 })
  }
  const refusal = removalRefusal(dir, 'archive', [])
  if (refusal !== null) {
    throw new Error(refusal)
  }
  return dir
}

function bytesIn(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0
  }
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0)
}

function tarPath(): string {
  const found = binaryPath('tar')
  if (found === null) {
    throw new Error('tar is not installed')
  }
  return found
}

const STDIN_CLOSED = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE'])

/**
 * Feeds `input` to tar. Node destroys a child's stdin when it exits, which can land before the
 * last write settles, so a closed stdin is no failure: the caller judges tar by its exit code.
 */
async function feedTar(stdin: Writable, input: readonly Readable[]): Promise<void> {
  try {
    await pipeline([...input, stdin])
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? e.code : undefined
    if (typeof code !== 'string' || !STDIN_CLOSED.has(code)) {
      throw e
    }
  }
}

/** Runs tar with no shell, feeding `input` to it or `output` from it, and waits for it to exit. */
async function runTar(args: string[], io: { input?: Readable[]; output?: Writable[] }): Promise<void> {
  const child = spawn(tarPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  const streams: Promise<void>[] = []
  if (io.input === undefined) {
    child.stdin.end()
  } else {
    streams.push(feedTar(child.stdin, io.input))
  }
  if (io.output === undefined) {
    child.stdout.resume()
  } else {
    streams.push(pipeline([child.stdout, ...io.output]))
  }
  const [code] = await Promise.all([exited, ...streams])
  if (code !== 0) {
    throw new Error(`tar exited with ${String(code)}: ${stderr.trim()}`)
  }
}

const zstd = () => zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })

async function pack(file: string, sources: readonly Source[]): Promise<void> {
  const excludes = BUNDLE_EXCLUDES.map((name) => `--exclude=${name}`)
  const members = sources.flatMap((source) => ['-C', path.dirname(source.dir), path.basename(source.dir)])
  await runTar(['-c', '-f', '-', ...excludes, ...members], {
    output: [zstd(), fs.createWriteStream(file, { mode: 0o600 })],
  })
}

/** The top-level names a bundle holds; reading it through checks every member decompresses. */
async function topNames(file: string): Promise<Set<string>> {
  const names = new Set<string>()
  const child = spawn(tarPath(), ['-t', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  child.stderr.resume()
  const listed = (async () => {
    for await (const line of readline.createInterface({ input: child.stdout })) {
      const [top = ''] = line.replace(/^\.\//, '').split('/')
      if (top !== '') {
        names.add(top)
      }
    }
  })()
  const feed = feedTar(child.stdin, [fs.createReadStream(file), zlib.createZstdDecompress()])
  const [code] = await Promise.all([exited, feed, listed])
  if (code !== 0) {
    throw new Error(`the bundle ${file} cannot be read`)
  }
  return names
}

async function unpack(file: string, dir: string): Promise<void> {
  await runTar(['-x', '-f', '-', '-C', path.dirname(dir), path.basename(dir)], {
    input: [fs.createReadStream(file), zlib.createZstdDecompress()],
  })
}

async function others(taskId: string): Promise<Task[]> {
  return (await tasks.listAll()).filter((task) => task.id !== taskId)
}

/** Why one of the folders must stay where it is now, or null when all of them may be packed. */
async function blocker(sources: readonly Source[], taskId: string): Promise<string | null> {
  const rest = await others(taskId)
  for (const source of sources) {
    if (path.basename(source.dir).startsWith('-')) {
      return `${source.dir} has a name tar would read as an option`
    }
    const refusal = removalRefusal(source.dir, ROOT_OF[source.kind], rest) ?? (await busyReason(source.dir))
    if (refusal !== null) {
      return refusal
    }
  }
  return null
}

function record(state: TaskFilesBundle['state'], taskId: string, folders: ArchivedFolder[], reason: string | null) {
  const dir = bundleDir(taskId)
  const bytes = bytesIn(dir)
  return { state, reason, path: bytes > 0 ? dir : null, bytes, folders, at: now() } satisfies TaskFilesBundle
}

async function removeSources(task: Task, sources: readonly Source[]): Promise<string | null> {
  const rest = await others(task.id)
  for (const source of sources) {
    if (source.kind === 'workspace') {
      await releaseWorkspace(task.id)
    }
    const refusal = await removeOwnedDir(source.dir, ROOT_OF[source.kind], rest)
    if (refusal !== null) {
      return refusal
    }
  }
  return null
}

/** A bundle left by an earlier try: its folders are packed already, so only the originals go. */
async function finishEarlier(task: Task, file: string, sources: readonly Source[]): Promise<TaskFilesBundle> {
  const names = await topNames(file)
  const folders: ArchivedFolder[] = [...names].map((name) =>
    name === task.id
      ? { kind: 'workspace', dir: workspaceDir(task.id), bytes: null }
      : { kind: 'scratch', dir: path.join(OWNED_ROOTS.scratch, name), bytes: null },
  )
  const unpacked = sources.filter((source) => !names.has(path.basename(source.dir)))
  if (unpacked.length > 0) {
    return record('pending', task.id, folders, `the bundle ${file} does not hold ${unpacked[0]?.dir ?? ''}`)
  }
  const refusal = (await blocker(sources, task.id)) ?? (await removeSources(task, sources))
  return record(refusal === null ? 'bundled' : 'pending', task.id, folders, refusal)
}

async function packSources(task: Task, file: string, sources: readonly Source[]): Promise<TaskFilesBundle> {
  const refusal = await blocker(sources, task.id)
  if (refusal !== null) {
    return record(
      'pending',
      task.id,
      sources.map((source) => ({ ...source, bytes: null })),
      refusal,
    )
  }
  const sized = await Promise.all(
    sources.map(async (source) => ({ kind: source.kind, dir: source.dir, bytes: await directoryBytes(source.dir) })),
  )
  ensureBundleDir(task.id)
  const partial = `${file}.partial`
  try {
    await pack(partial, sources)
    const names = await topNames(partial)
    const missing = sources.find((source) => !names.has(path.basename(source.dir)))
    if (missing !== undefined) {
      throw new Error(`the bundle came out without ${missing.dir}`)
    }
    fs.renameSync(partial, file)
  } catch (e) {
    fs.rmSync(partial, { force: true })
    return record('pending', task.id, sized, `packing failed: ${errorText(e)}`)
  }
  const removal = await removeSources(task, sources)
  return record(removal === null ? 'bundled' : 'pending', task.id, sized, removal)
}

async function auditBundled(task: Task, files: TaskFilesBundle): Promise<void> {
  const freed = files.folders.reduce((sum, folder) => sum + (folder.bytes ?? 0), 0)
  await audit.record({
    actor: 'system',
    kind: 'task.files_archived',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Packed the folders of archived agent "${task.title}" into ${String(files.bytes)} bytes`,
    detail: {
      title: task.title,
      bundle: files.path,
      bytes: files.bytes,
      freed_bytes: freed,
      folders: files.folders.map((folder) => folder.dir),
    },
  })
}

/**
 * Packs an archived task's scratch folder and workspace into one tar.zst under the archive root,
 * then removes them. A folder in use, locked or not plainly the task's own stays, and the files
 * are left pending for the lifecycle sweep to try again. Null when the task is not archived.
 */
export async function bundleTaskFiles(taskId: string): Promise<TaskFilesBundle | null> {
  return oneAtATime(async () => packInLane(taskId))
}

let packing: Promise<unknown> = Promise.resolve()

/** Packs one bundle at a time, so archiving many agents at once runs one tar, not dozens. */
async function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = packing.then(work, work)
  packing = run.catch(() => undefined)
  return run
}

async function packInLane(taskId: string): Promise<TaskFilesBundle | null> {
  return inLane(taskId, async () => {
    const [task, archive] = await Promise.all([tasks.get(taskId), taskArchives.get(taskId)])
    if (task === undefined || archive === undefined) {
      return null
    }
    if (task.archived_at === null) {
      return null
    }
    if (archive.files !== null && archive.files.state !== 'pending') {
      return archive.files
    }
    const sources = sourcesOf(task)
    const file = bundleFile(task.id, archive.archived_at)
    let files: TaskFilesBundle
    if (fs.existsSync(file)) {
      files = await finishEarlier(task, file, sources)
    } else if (sources.length === 0) {
      files = record('none', task.id, [], null)
    } else {
      files = await packSources(task, file, sources)
    }
    await taskArchives.setFiles(task.id, files)
    if (files.state === 'bundled') {
      await auditBundled(task, files)
    }
    return files
  })
}

export interface Unpacked {
  folders: RestoredFolder[]
  /** Removes what this restore unpacked, when the rest of the restore failed. */
  undo: () => Promise<void>
  /** Drops the bundle once every folder is back; else keeps it for the user. */
  finish: () => Promise<void>
}

/** Unpacks an archived task's folders where they were; a folder something took meanwhile stays. */
export async function unpackTaskFiles(
  taskId: string,
  archive: { files: TaskFilesBundle | null; archived_at: string },
): Promise<Unpacked> {
  const { files } = archive
  const file = bundleFile(taskId, archive.archived_at)
  const noop = async () => {
    await Promise.resolve()
  }
  if (files?.state !== 'bundled' || !fs.existsSync(file)) {
    return { folders: [], undo: noop, finish: noop }
  }
  const made: { dir: string; root: OwnedRoot }[] = []
  const folders: RestoredFolder[] = []
  const undo = async () => {
    for (const { dir, root } of made) {
      await removeOwnedDir(dir, root, [])
    }
  }
  try {
    for (const folder of files.folders) {
      const root = ROOT_OF[folder.kind]
      const free = path.dirname(folder.dir) === OWNED_ROOTS[root] && !fs.existsSync(folder.dir)
      if (free) {
        fs.mkdirSync(OWNED_ROOTS[root], { recursive: true })
        await unpack(file, folder.dir)
        made.push({ dir: folder.dir, root })
      }
      folders.push({ dir: folder.dir, restored: free })
    }
  } catch (e) {
    await undo()
    throw e
  }
  const finish = async () => {
    if (folders.every((folder) => folder.restored)) {
      fs.rmSync(file)
      fs.rmSync(patchesDir(taskId), { recursive: true, force: true })
      if (fs.readdirSync(bundleDir(taskId)).length === 0) {
        await removeOwnedDir(bundleDir(taskId), 'archive', [])
      }
    }
  }
  return { folders, undo, finish }
}

/**
 * Removes a deleted task's scratch folder, workspace and archive bundle, each checked to be the
 * task's own first. Returns what it left and why, such as a folder another agent uses.
 */
export async function removeTaskFolders(task: Task): Promise<string[]> {
  return inLane(task.id, async () => {
    const rest = await others(task.id)
    const left: string[] = []
    const scratch = scratchDirOf(task)
    if (scratch !== null && fs.existsSync(scratch)) {
      const refusal = await removeOwnedDir(scratch, 'scratch', rest)
      left.push(...(refusal === null ? [] : [refusal]))
    }
    await releaseWorkspace(task.id)
    for (const [dir, root] of [
      [workspaceDir(task.id), 'workspace'],
      [bundleDir(task.id), 'archive'],
    ] as const) {
      if (fs.existsSync(dir)) {
        const refusal = await removeOwnedDir(dir, root, root === 'archive' ? [] : rest)
        left.push(...(refusal === null ? [] : [refusal]))
      }
    }
    return left
  })
}

/**
 * Removes a deleted task's sandbox state, its folders and the worktrees Seti made for it (also
 * those taken off it). A folder another agent uses, or a process works in, stays and is logged.
 */
export async function removeTaskFiles(task: Task): Promise<void> {
  await removeTaskSandbox(task.id)
  const left = await removeTaskFolders(task)
  const rest = await others(task.id)
  for (const worktree of await taskLocation.worktrees(task.id)) {
    const refusal = fs.existsSync(worktree.dir)
      ? (removalRefusal(worktree.dir, 'worktrees', rest) ?? (await busyReason(worktree.dir)))
      : null
    if (refusal === null) {
      await removeWorktree(worktree.repo_path, worktree.dir)
    } else {
      left.push(refusal)
    }
  }
  for (const reason of left) {
    process.stdout.write(`delete: kept a folder of task ${task.id}: ${reason}\n`)
  }
}

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { NOISE_DIRS, type FileNameHit, type FileSearch, type FileSearchQuery, type FileTextHit } from '@seti/shared'
import { binaryPath } from './binaries.js'
import { matchPath, type PathMatch } from './fuzzy-path.js'
import { HttpError } from './http.js'
import {
  inNestedRoot,
  isSetiFile,
  locate,
  openRoots,
  pathProblem,
  type FileContext,
  type OpenRoot,
} from './task-files.js'

/** How long one search may run across all roots before it returns what it found. */
const SEARCH_TIMEOUT_MS = 5_000
/** Paths a name search scores at most, so a huge home folder cannot exhaust memory. */
const NAME_SCAN_MAX = 200_000
/** Matches ripgrep reports per file, so one log file cannot fill the whole result. */
const MATCHES_PER_FILE = 20
const SNIPPET_CHARS = 240
const STDERR_MAX = 2_000

export interface SearchOptions {
  /** ripgrep's path, or null to walk the roots in process. */
  rg: string | null
  timeoutMs: number
  /** Aborted when the client goes away, which stops the search. */
  signal?: AbortSignal | undefined
}

export const searchOptions = (signal?: AbortSignal): SearchOptions => ({
  rg: binaryPath('rg'),
  timeoutMs: SEARCH_TIMEOUT_MS,
  signal,
})

interface Run {
  files: FileContext
  /** Every open root, each real folder once. */
  roots: readonly OpenRoot[]
  query: FileSearchQuery
  deadline: number
  options: SearchOptions
}

type Stop = 'done' | 'full' | 'late'

/** The path as the Files view serves it, or null when its rules keep the path out. */
function servable(run: Run, root: OpenRoot, rel: string): string | null {
  try {
    const at = locate(run.files, root.id, rel, { dotfiles: run.query.dotfiles })
    return at.rel === '' ? null : at.rel
  } catch {
    return null
  }
}

const rgBase = (dotfiles: boolean) => [
  '--no-config',
  '--no-follow',
  '--no-ignore-parent',
  '--no-messages',
  '--color',
  'never',
  ...(dotfiles ? ['--hidden'] : []),
  ...NOISE_DIRS.flatMap((dir) => ['--glob', `!${dir}`]),
]

interface Lines {
  bin: string
  args: string[]
  cwd: string
  run: Run
  /** Takes each line of output; false stops the search as full. */
  take: (line: string) => boolean
}

interface Ran {
  stop: Stop
  code: number | null
  stderr: string
}

/** Runs ripgrep with arguments, never a shell, until it ends, the take is full or time runs out. */
async function runLines({ bin, args, cwd, run, take }: Lines): Promise<Ran> {
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const state: { stop: Stop; stderr: string } = { stop: 'done', stderr: '' }
  const halt = (stop: Stop) => {
    if (state.stop === 'done') {
      state.stop = stop
    }
    child.kill('SIGKILL')
  }
  const timer = setTimeout(
    () => {
      halt('late')
    },
    Math.max(0, run.deadline - Date.now()),
  )
  const abort = () => {
    halt('late')
  }
  run.options.signal?.addEventListener('abort', abort)
  if (run.options.signal?.aborted === true) {
    abort()
  }
  child.stderr.on('data', (chunk: Buffer) => {
    state.stderr = (state.stderr + chunk.toString('utf8')).slice(0, STDERR_MAX)
  })
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', resolve)
    child.on('error', () => {
      resolve(null)
    })
  })
  for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (state.stop === 'done' && !take(line)) {
      halt('full')
    }
  }
  const code = await closed
  clearTimeout(timer)
  run.options.signal?.removeEventListener('abort', abort)
  return { stop: state.stop, code, stderr: state.stderr }
}

/**
 * A cheap check on the path as named; hits pass the full check through its real path later.
 * A nested root's files are left to that root, and Seti's own files to those who ask for them.
 */
function refused(root: OpenRoot, rel: string, run: Run): boolean {
  const full = path.join(root.real, rel)
  return (
    pathProblem(full, run.files.rules) !== null ||
    inNestedRoot(full, root, run.roots) ||
    (!run.query.seti_files && isSetiFile(full, run.files.rules))
  )
}

const stripDot = (rel: string) => (rel.startsWith('./') ? rel.slice(2) : rel)

function readFolder(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Whether the walk takes an entry: no links, no noise folders, dot files only when asked. */
function walkable(dirent: fs.Dirent, child: string, root: OpenRoot, run: Run): boolean {
  if (dirent.isSymbolicLink() || (!run.query.dotfiles && dirent.name.startsWith('.'))) {
    return false
  }
  return !NOISE_DIRS.some((noise) => noise === dirent.name) && !refused(root, child, run)
}

/** The entries of one folder the walk takes, as paths relative to the root. */
function walkFolder(root: OpenRoot, run: Run, rel: string): { child: string; dir: boolean }[] {
  return readFolder(path.join(root.real, rel)).flatMap((dirent) => {
    const child = rel === '' ? dirent.name : `${rel}/${dirent.name}`
    return walkable(dirent, child, root, run) ? [{ child, dir: dirent.isDirectory() }] : []
  })
}

/** Every file and folder of a root an in-process walk reaches, for hosts without ripgrep. */
function walkNames(root: OpenRoot, run: Run, room: number): { names: string[]; stop: Stop } {
  const names: string[] = []
  const queue = ['']
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    if (Date.now() > run.deadline) {
      return { names, stop: 'late' }
    }
    for (const { child, dir } of walkFolder(root, run, rel)) {
      if (names.push(child) >= room) {
        return { names, stop: 'full' }
      }
      if (dir) {
        queue.push(child)
      }
    }
  }
  return { names, stop: 'done' }
}

/** A root's file paths, and the folders that hold them, through ripgrep or the walk. */
async function namesOf(root: OpenRoot, run: Run, room: number): Promise<{ names: string[]; stop: Stop }> {
  const { rg } = run.options
  if (rg === null) {
    return walkNames(root, run, room)
  }
  const names = new Set<string>()
  const ran = await runLines({
    bin: rg,
    args: ['--files', ...rgBase(run.query.dotfiles), '.'],
    cwd: root.real,
    run,
    take: (line) => {
      const rel = stripDot(line)
      if (refused(root, rel, run)) {
        return true
      }
      for (let at = rel.indexOf('/'); at > 0; at = rel.indexOf('/', at + 1)) {
        names.add(rel.slice(0, at))
      }
      names.add(rel)
      return names.size < room
    },
  })
  return { names: [...names], stop: ran.stop }
}

interface Scored extends PathMatch {
  root: OpenRoot
  rel: string
}

function byScore(a: Scored, b: Scored): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  return a.rel.length === b.rel.length ? a.rel.localeCompare(b.rel, 'en') : a.rel.length - b.rel.length
}

/** Every path across the roots that matches the query, and why the scan stopped. */
async function scoreRoots(run: Run): Promise<{ scored: Scored[]; stop: Stop }> {
  const query = run.query.q.toLowerCase().replace(/\s+/g, '')
  const scored: Scored[] = []
  let stop: Stop = 'done'
  let room = NAME_SCAN_MAX
  for (const root of run.roots) {
    const found = await namesOf(root, run, room)
    room -= found.names.length
    stop = found.stop === 'done' ? stop : found.stop
    for (const rel of found.names) {
      const match = matchPath(rel, query)
      if (match !== null) {
        scored.push({ ...match, root, rel })
      }
    }
    if (stop !== 'done') {
      break
    }
  }
  return { scored, stop }
}

/** File and folder paths across the roots that fuzzy match the query, best first. */
async function searchNames(run: Run): Promise<FileSearch> {
  const { scored, stop } = await scoreRoots(run)
  const hits: FileNameHit[] = []
  const ranked = scored.toSorted(byScore)
  let next = 0
  for (; next < ranked.length && hits.length < run.query.limit; next++) {
    const hit = ranked[next]
    const rel = hit === undefined ? null : servable(run, hit.root, hit.rel)
    if (hit !== undefined && rel !== null) {
      const isDir = fs.statSync(path.join(hit.root.real, rel), { throwIfNoEntry: false })?.isDirectory() === true
      hits.push({ root: hit.root.id, path: rel, type: isDir ? 'dir' : 'file', marks: hit.marks })
    }
  }
  return { mode: 'name', hits, truncated: next < ranked.length, partial: stop !== 'done' }
}

interface RgText {
  text?: string
}

interface RgMatch {
  type: string
  data?: {
    path?: RgText
    lines?: RgText
    line_number?: number
    submatches?: { start: number; end: number }[]
  }
}

/** A line shortened around its first match, with the match ranges moved to fit. */
function snippet(line: string, marks: [number, number][]): { text: string; marks: [number, number][] } {
  if (line.length <= SNIPPET_CHARS) {
    return { text: line, marks }
  }
  const first = marks[0]?.[0] ?? 0
  const start = Math.max(0, Math.min(first - SNIPPET_CHARS / 4, line.length - SNIPPET_CHARS))
  const end = start + SNIPPET_CHARS
  const kept = marks
    .filter(([from]) => from >= start && from < end)
    .map(([from, to]): [number, number] => [from - start, Math.min(to, end) - start])
  return { text: line.slice(start, end), marks: kept }
}

function parseMatch(line: string): RgMatch | null {
  try {
    return JSON.parse(line) as RgMatch
  } catch {
    return null
  }
}

/** One match line of `rg --json` as a hit; null for other messages and names that are not UTF-8. */
function textHit(line: string, root: OpenRoot): { rel: string; hit: Omit<FileTextHit, 'path'> } | null {
  const message = parseMatch(line)
  const data = message?.data
  const file = data?.path?.text
  const raw = data?.lines?.text
  if (message?.type !== 'match' || file === undefined || raw === undefined || data?.line_number === undefined) {
    return null
  }
  const bytes = Buffer.from(raw, 'utf8')
  const at = (offset: number) => bytes.subarray(0, offset).toString('utf8').length
  const marks = (data.submatches ?? []).map(({ start, end }): [number, number] => [at(start), at(end)])
  const shown = snippet(raw.replace(/\r?\n$/, ''), marks)
  return { rel: stripDot(file), hit: { root: root.id, line: data.line_number, ...shown } }
}

interface TextFile {
  run: Run
  root: OpenRoot
  rel: string
  /** The path each file seen so far shows, or null when it is left out. */
  allowed: Map<string, string | null>
}

/** The path a text hit's file shows as, worked out once per file; null leaves it out. */
function shownPath({ run, root, rel, allowed }: TextFile): string | null {
  const known = allowed.get(rel)
  if (known !== undefined) {
    return known
  }
  const shown = refused(root, rel, run) ? null : servable(run, root, rel)
  allowed.set(rel, shown)
  return shown
}

/** Lines holding the query inside the roots' files, through ripgrep, in the order it finds them. */
async function searchText(run: Run): Promise<FileSearch> {
  const { rg } = run.options
  if (rg === null) {
    throw new HttpError(503, 'Text search needs ripgrep (rg) on the host running Seti')
  }
  const hits: FileTextHit[] = []
  const flags = ['--json', '--smart-case', '--max-count', String(MATCHES_PER_FILE), '--max-filesize', '2M']
  const args = [...flags, ...(run.query.regex ? [] : ['--fixed-strings']), ...rgBase(run.query.dotfiles)]
  let stop: Stop = 'done'
  for (const root of run.roots) {
    const allowed = new Map<string, string | null>()
    const ran = await runLines({
      bin: rg,
      args: [...args, '-e', run.query.q, '.'],
      cwd: root.real,
      run,
      take: (line) => {
        const found = textHit(line, root)
        if (found === null) {
          return true
        }
        const { rel, hit } = found
        const shown = shownPath({ run, root, rel, allowed })
        if (shown !== null) {
          hits.push({ ...hit, path: shown })
        }
        return hits.length <= run.query.limit
      },
    })
    if (ran.code === 2 && hits.length === 0 && ran.stop === 'done' && ran.stderr.trim() !== '') {
      throw new HttpError(400, `The search failed: ${ran.stderr.trim().split('\n')[0] ?? ''}`)
    }
    stop = ran.stop
    if (stop !== 'done') {
      break
    }
  }
  return {
    mode: 'text',
    hits: hits.slice(0, run.query.limit),
    truncated: hits.length > run.query.limit,
    partial: stop === 'late',
  }
}

/** Searches the task's roots by path or content, serving only what the Files view would open. */
export async function searchFiles(
  files: FileContext,
  query: FileSearchQuery,
  options: SearchOptions,
): Promise<FileSearch> {
  const run: Run = { files, roots: openRoots(files), query, deadline: Date.now() + options.timeoutMs, options }
  return query.mode === 'name' ? searchNames(run) : searchText(run)
}

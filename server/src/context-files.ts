import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ContextFile, ContextFileContent, Repo } from '@seti/shared'
import { CLAUDE_HOME } from './config.js'
import { repos } from './db.js'
import { HttpError } from './http.js'

const REPO_FILES = { project: 'CLAUDE.md', local: 'CLAUDE.local.md' } as const
type RepoFileKind = keyof typeof REPO_FILES

const REPO_KEY = /^repo:([^:]+):(project|local)$/

interface Location {
  key: string
  group: string
  label: string
  path: string
  /** Directory Seti may create when missing; repo checkouts must already exist. */
  creatable: boolean
}

const userLocation = (): Location => ({
  key: 'user',
  group: 'User level',
  label: 'CLAUDE.md',
  path: path.join(CLAUDE_HOME, 'CLAUDE.md'),
  creatable: true,
})

const repoLocation = (repo: Repo, kind: RepoFileKind): Location => ({
  key: `repo:${repo.id}:${kind}`,
  group: repo.slug,
  label: REPO_FILES[kind],
  path: path.join(repo.path, REPO_FILES[kind]),
  creatable: false,
})

/** Maps a file key to its computed path. Keys never carry paths, so nothing else is reachable. */
export async function resolveContextFile(key: string): Promise<Location> {
  if (key === 'user') {
    return userLocation()
  }
  const match = REPO_KEY.exec(key)
  const [, repoId = '', kind] = match ?? []
  if (kind !== 'project' && kind !== 'local') {
    throw new HttpError(404, 'Unknown context file')
  }
  const repo = await repos.get(repoId)
  if (!repo) {
    throw new HttpError(404, 'Unknown repo')
  }
  return repoLocation(repo, kind)
}

const hashOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

function statOf(file: string): fs.Stats | null {
  const stats = fs.statSync(file, { throwIfNoEntry: false })
  return stats?.isFile() === true ? stats : null
}

function describe(location: Location): ContextFile {
  const stats = statOf(location.path)
  return {
    key: location.key,
    group: location.group,
    label: location.label,
    path: location.path,
    exists: stats !== null,
    size: stats?.size ?? null,
    modified_at: stats?.mtime.toISOString() ?? null,
  }
}

export async function listContextFiles(): Promise<ContextFile[]> {
  const locations = [
    userLocation(),
    ...(await repos.list()).flatMap((repo) => [repoLocation(repo, 'project'), repoLocation(repo, 'local')]),
  ]
  return locations.map(describe)
}

function readLocation(location: Location): ContextFileContent {
  const file = describe(location)
  const content = file.exists ? fs.readFileSync(location.path, 'utf8') : ''
  return { ...file, content, hash: file.exists ? hashOf(content) : null }
}

export const readContextFile = async (key: string) => readLocation(await resolveContextFile(key))

const withTrailingNewline = (content: string) => (content === '' || content.endsWith('\n') ? content : `${content}\n`)

/** Writes through symlinks to their target, so a linked CLAUDE.md stays linked. */
function writeTarget(location: Location): string {
  if (statOf(location.path) === null) {
    return location.path
  }
  return fs.realpathSync(location.path)
}

function ensureDirectory(location: Location, dir: string): void {
  if (fs.existsSync(dir)) {
    return
  }
  if (!location.creatable) {
    throw new HttpError(400, `Directory ${dir} does not exist`)
  }
  fs.mkdirSync(dir, { recursive: true })
}

function atomicWrite(target: string, text: string): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const mode = statOf(target)?.mode ?? 0o644
  try {
    fs.writeFileSync(tmp, text, { mode, flag: 'wx' })
    fs.renameSync(tmp, target)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/** Writes only while the file still hashes to baseHash (null: absent), else throws 409. */
export async function writeContextFile(
  key: string,
  content: string,
  baseHash: string | null,
): Promise<ContextFileContent> {
  const location = await resolveContextFile(key)
  const current = readLocation(location)
  if (current.hash !== baseHash) {
    throw new HttpError(409, 'The file changed on disk since it was loaded')
  }
  const target = writeTarget(location)
  ensureDirectory(location, path.dirname(target))
  atomicWrite(target, withTrailingNewline(content))
  return readLocation(location)
}

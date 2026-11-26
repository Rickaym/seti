import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolCall } from '@seti/shared'
import { tasks } from '../db.js'
import { agentGitReading } from '../git.js'
import { agentGitView } from '../outward-folder.js'
import { within } from '../owned-dirs.js'
import { isRecord, NUMBERED, shownLines, type FoundItem } from './item.js'
import { blobPermalink, fileRef, githubRepo } from './refs.js'

/** A file an agent read with its file reading tool, as the agent named it. */
export interface FileAsk {
  path: string
  /** Whether the call asked for part of the file only. */
  part: boolean
}

/** Claude Code's Read shows at most this many lines when no limit is asked for. */
const READ_LINES = 2000
const GIT_TIMEOUT_MS = 5000

/** The file a read call names, or null for any other call. */
export function fileAsk(call: ToolCall): FileAsk | null {
  const [named, ...more] = call.read?.paths ?? []
  if (call.kind !== 'read' || named === undefined || more.length > 0 || !path.isAbsolute(named)) {
    return null
  }
  const part = isRecord(call.input) && (call.input.offset !== undefined || call.input.limit !== undefined)
  return { path: path.normalize(named), part }
}

type Git = (...args: string[]) => Promise<string>

/** `owner/repo` of a GitHub remote URL, or null for any other host or form. */
export function githubRemote(url: string): string | null {
  const found =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    )
  return found === null ? null : githubRepo(found[1] ?? '', found[2] ?? '')
}

/**
 * The commit a file sits at on GitHub: HEAD, when HEAD holds the file byte for byte and is on a
 * branch of origin as the clone last fetched it; null for a local copy. The bytes are hashed with
 * no filter, since a filter the repository names would run a program.
 */
async function pushedAt(git: Git, file: string, real: string): Promise<string | null> {
  const [held, read, sha, pushed] = await Promise.all([
    git('rev-parse', '--verify', '--quiet', `HEAD:${file}`).catch(() => ''),
    git('hash-object', '--no-filters', '--', real).catch(() => 'unread'),
    git('rev-parse', '--verify', 'HEAD^{commit}').catch(() => ''),
    git('for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes/origin').catch(
      () => '',
    ),
  ])
  return held === read && /^[0-9a-f]{40}$/.test(sha) && pushed !== '' ? sha : null
}

/** The lines a read showed, or null when it showed the whole file. */
function linesOf(ask: FileAsk, text: string): [number, number] | null {
  const lines = shownLines(text)
  const whole = lines !== null && !ask.part && lines[0] === 1 && lines[1] < READ_LINES
  return whole ? null : lines
}

/**
 * The item a file read is, when the file sits in a git clone whose origin is on GitHub: at its
 * commit with a permalink when it is tracked, unchanged and pushed, else as a local copy with
 * none. The path is the agent's, mapped to the host as its git sees it; the file's real path must
 * stay inside the clone its named folder is in. Git runs with the hostile-repository guards.
 */
export async function fileItems(taskId: string, ask: FileAsk, text: string): Promise<FoundItem[]> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return []
  }
  const named = (await agentGitView(task)).folder(ask.path)
  const git: Git = async (...args) => agentGitReading(GIT_TIMEOUT_MS, path.dirname(named), [], ...args)
  const [top, real, origin] = await Promise.all([
    git('rev-parse', '--show-toplevel').then(async (found) => fs.realpath(found)),
    fs.realpath(named),
    git('remote', 'get-url', 'origin').catch(() => ''),
  ])
  const repo = githubRemote(origin)
  if (repo === null || !within(real, top) || !(await fs.stat(real)).isFile()) {
    return []
  }
  const file = path.relative(top, real).split(path.sep).join('/')
  const sha = await pushedAt(git, file, real)
  const base = { kind: 'file' as const, container: repo, at: null, spans: [NUMBERED] }
  return sha === null
    ? [{ ...base, ref: fileRef(repo, file, null), permalink: '' }]
    : [{ ...base, ref: fileRef(repo, file, sha), permalink: blobPermalink(repo, file, sha, linesOf(ask, text)) }]
}

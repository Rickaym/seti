import os from 'node:os'
import path from 'node:path'
import type { ToolCall } from '@seti/shared'
import { tasks } from '../db.js'
import { agentGitReading } from '../git.js'
import { agentGitView } from '../outward-folder.js'
import { rerouting } from '../policy/outward.js'
import { walkLine } from '../policy/shell-scope.js'
import { shellCommands } from '../policy/shell-split.js'
import { branchesAt, githubRemote } from './files.js'
import { at, isoTime, type FoundItem } from './item.js'
import { lineOutput, printsToFile } from './line-output.js'
import { commitRef } from './refs.js'

/** A shell line that may show commits with `git show` or `git log`. */
export interface CommitAsk {
  command: string
}

const GIT_TIMEOUT_MS = 5000
/** Commits one result records at most, so a long `git log -p` stays a bounded number of rows. */
const MAX_COMMITS = 50
const HEADER = /^commit ([0-9a-f]{40})(?: \([^\n]*\))?$/gm
/** Options that change the header git prints, so the result no longer says which commit is which. */
const REFORMATS = /^--(?:format|pretty|oneline|graph|output|source|abbrev-commit)(?:=|$)/

/** The line of a call that runs `git show` or `git log`, or null for any other call. */
export function commitAsk(call: ToolCall): CommitAsk | null {
  const command = call.shell?.action === 'run' ? call.shell.command : undefined
  return command !== undefined && /\bgit\b/.test(command) && /\b(?:show|log)\b/.test(command) ? { command } : null
}

/** The folder a `git show` or `git log` reads, from its `-C`; undefined for any other form. */
function gitRead(words: readonly string[], dir: string | null): { dir: string | null } | undefined {
  let index = 1
  let where = dir
  while ((words[index] ?? '').startsWith('-')) {
    const word = words[index] ?? ''
    if (word === '-C') {
      const given = words[index + 1] ?? ''
      where = path.isAbsolute(given) || where !== null ? path.resolve(where ?? '/', given) : null
      index += 2
    } else if (word === '--no-pager' || word === '-P') {
      index += 1
    } else {
      return undefined
    }
  }
  const command = words[index]
  const args = words.slice(index + 1)
  const reads = (command === 'show' || command === 'log') && !args.some((word) => REFORMATS.test(word))
  return reads && !words.some((word) => /[$`]/.test(word)) ? { dir: where } : undefined
}

/** The folder of the one `git show` or `git log` a line runs alone, as the outward check reads it. */
function shownFrom(command: string, cwd: string | null): string | null {
  if (rerouting(shellCommands(command)).git !== undefined || printsToFile(command, 'git')) {
    return null
  }
  const dirs: (string | null)[] = []
  walkLine(command, { cwd, home: os.homedir() }, (forms, dir) => {
    const words = forms.find((form) => form[0] === 'git')
    const read = words === undefined ? undefined : gitRead(words, dir)
    if (read !== undefined) {
      dirs.push(read.dir)
    }
  })
  const [dir, ...more] = dirs
  return dir === undefined || more.length > 0 || lineOutput(command, 'git') === 'mixed' ? null : dir
}

/** Each commit header in the result with the span of text up to the next one. */
function shown(text: string): { sha: string; span: string }[] {
  const found = [...text.matchAll(HEADER)].slice(0, MAX_COMMITS)
  return found.map((match, i) => {
    const end = found[i + 1]?.index ?? text.length
    return { sha: match[1] ?? '', span: at([], [match.index, end]) }
  })
}

/**
 * The commits a lone `git show` or `git log` printed, in a clone whose `origin` is on GitHub: one
 * item per commit header the clone holds, linked when a branch of `origin` contains it. The line
 * starts in the agent's folder; a hash the clone does not hold gives no item, so a guess at the
 * folder cannot name another repository's commit.
 */
export async function commitItems(taskId: string, ask: CommitAsk, text: string): Promise<FoundItem[]> {
  const task = await tasks.get(taskId)
  const dir = task === undefined ? null : shownFrom(ask.command, task.cwd)
  const commits = shown(text)
  if (task === undefined || dir === null || commits.length === 0) {
    return []
  }
  const folder = (await agentGitView(task)).folder(dir)
  const git = async (...args: string[]) => agentGitReading(GIT_TIMEOUT_MS, folder, [], ...args)
  const repo = githubRemote(await git('remote', 'get-url', 'origin').catch(() => ''))
  if (repo === null) {
    return []
  }
  const shas = commits.map(({ sha }) => sha)
  const dated = await git('log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %aI', ...shas).catch(() => '')
  const times = new Map(dated.split('\n').map((line) => [line.slice(0, 40), line.slice(41)] as const))
  const held = commits.filter(({ sha }) => times.has(sha))
  return Promise.all(
    held.map(async ({ sha, span }) => {
      const on = ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)', 'refs/remotes/origin']
      const pushed = (await git(...on).catch(() => '')) !== ''
      const permalink = pushed ? `https://github.com/${repo}/commit/${sha}` : ''
      const ref = commitRef(repo, sha)
      const branches = pushed ? await branchesAt(git, sha) : []
      return {
        kind: 'github' as const,
        container: repo,
        ref,
        permalink,
        at: isoTime(times.get(sha)),
        spans: [span],
        branches,
      }
    }),
  )
}

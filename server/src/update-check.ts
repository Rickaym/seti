import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SetiUpdate } from '@seti/shared'
import { inBackground } from './background.js'
import { readCommits, runningVersion } from './changelog.js'
import { git } from './git.js'

const exec = promisify(execFile)

/** The branch an install updates to, as scripts/upgrade.sh does by default. */
const UPDATE_BRANCH = 'main'
const FETCH_TIMEOUT_MS = 30_000
const BEHIND_SCAN = 2000
/** How old a check the polled status may show before it starts another one in the background. */
const STATUS_MAX_AGE_MS = 30 * 60_000
/** How old a check an explicit read may show; a newer one is awaited. */
export const READ_MAX_AGE_MS = 2 * 60_000

const QUOTED_QUOTE = `'\\''`
const quote = (text: string) => (/^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", QUOTED_QUOTE)}'`)

/** The installer's upgrade script when the checkout has it, else the steps it takes. */
export function updateCommand(dir: string): string {
  const cd = `cd ${quote(dir)}`
  if (fs.existsSync(path.join(dir, 'scripts', 'upgrade.sh'))) {
    return `${cd}\nscripts/upgrade.sh`
  }
  return [
    cd,
    `git fetch origin ${UPDATE_BRANCH}`,
    `git checkout --detach origin/${UPDATE_BRANCH}`,
    'pnpm install --frozen-lockfile',
    'pnpm build',
    'systemctl --user restart seti.service',
  ].join('\n')
}

/** The first line git wrote to stderr, without its `fatal:` prefix. */
function reason(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    if ('killed' in e && e.killed === true) {
      return `git fetch took longer than ${String(FETCH_TIMEOUT_MS / 1000)} s`
    }
    if ('stderr' in e && typeof e.stderr === 'string') {
      const line = e.stderr
        .split('\n')
        .map((text) => text.replace(/^(fatal|error): /, '').trim())
        .find((text) => text !== '')
      if (line !== undefined) {
        return line
      }
    }
  }
  return e instanceof Error ? e.message : String(e)
}

/** Fetches the branch with the checkout's own git credentials and answers its newest commit. */
async function fetchBranch(dir: string): Promise<string> {
  await exec('git', ['-C', dir, 'fetch', '--quiet', '--no-tags', 'origin', UPDATE_BRANCH], {
    timeout: FETCH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return git(dir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}')
}

async function check(dir: string): Promise<SetiUpdate> {
  const base = {
    branch: UPDATE_BRANCH,
    checked_at: new Date().toISOString(),
    command: updateCommand(dir),
  }
  const unknown = (error: string): SetiUpdate => ({
    ...base,
    state: 'unknown',
    latest: null,
    behind: null,
    notable: null,
    error,
  })
  const version = await runningVersion(dir)
  if (version === null) {
    return unknown('Seti does not run from a git checkout.')
  }
  let latest: string
  try {
    latest = await fetchBranch(dir)
  } catch (e) {
    return unknown(reason(e))
  }
  try {
    const [head] = await readCommits(dir, latest, 1)
    const missing = await readCommits(dir, `${version.commit}..${latest}`, BEHIND_SCAN)
    return {
      ...base,
      state: missing.length > 0 ? 'available' : 'current',
      latest: head === undefined ? null : { commit: head.commit, date: head.date },
      behind: missing.length,
      notable: missing.filter((commit) => commit.notable).length,
      error: null,
    }
  } catch (e) {
    return unknown(reason(e))
  }
}

interface Checked {
  update: SetiUpdate
  at: number
}

const checked = new Map<string, Checked>()
const pending = new Map<string, Promise<SetiUpdate>>()

/** Runs one check of `dir` at a time and keeps its answer. */
export async function checkForUpdate(dir: string): Promise<SetiUpdate> {
  const running = pending.get(dir)
  if (running !== undefined) {
    return running
  }
  const started = check(dir)
    .then((update) => {
      checked.set(dir, { update, at: Date.now() })
      return update
    })
    .finally(() => {
      pending.delete(dir)
    })
  pending.set(dir, started)
  return started
}

/** The last answer, refreshed first when it is older than `maxAgeMs`. */
export async function freshUpdate(dir: string, maxAgeMs: number): Promise<SetiUpdate> {
  const last = checked.get(dir)
  return last !== undefined && Date.now() - last.at <= maxAgeMs ? last.update : checkForUpdate(dir)
}

/** Checks in the background; startup calls it so the first status poll finds an answer. */
export function startUpdateCheck(dir: string): void {
  inBackground('update check', async () => checkForUpdate(dir))
}

/** The last answer without waiting; a stale or missing one starts a check in the background. */
export function lastUpdate(dir: string): SetiUpdate | null {
  const last = checked.get(dir)
  if ((last === undefined || Date.now() - last.at > STATUS_MAX_AGE_MS) && !pending.has(dir)) {
    startUpdateCheck(dir)
  }
  return last?.update ?? null
}

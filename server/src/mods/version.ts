import type { SetiVersionApi } from '@seti/mod-api'
import { CHANGELOG_LIMIT_MAX, type ChangelogStatus } from '@seti/shared'
import { readChangelog, recordRunningVersion } from '../changelog.js'
import { SETI_SOURCE_DIR } from '../config.js'
import { HttpError } from '../http.js'
import { changelogStore } from '../store/changelog.js'
import { freshUpdate, lastUpdate, READ_MAX_AGE_MS, startUpdateCheck } from '../update-check.js'
import { requireOp } from './capabilities.js'

const COMMIT = /^[0-9a-f]{40}$/

async function status(dir: string): Promise<ChangelogStatus> {
  const { version, unseen } = await readChangelog(dir, 1)
  return { version, unseen, update: lastUpdate(dir) }
}

function limitOf(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANGELOG_LIMIT_MAX) {
    throw new HttpError(400, `A changelog limit is a whole number from 1 to ${String(CHANGELOG_LIMIT_MAX)}`)
  }
  return limit
}

/** The seti.version capability: the running checkout's history and updates, read by Seti. */
export function versionApi(run: <T>(fn: () => Promise<T>) => Promise<T>, dir = SETI_SOURCE_DIR): SetiVersionApi {
  const granted = async <T>(fn: () => Promise<T>) =>
    run(async () => {
      requireOp('seti.version')
      return fn()
    })
  return {
    changelog: async (limit) => granted(async () => readChangelog(dir, limitOf(limit))),
    status: async () => granted(async () => status(dir)),
    update: async () => granted(async () => freshUpdate(dir, READ_MAX_AGE_MS)),
    markSeen: async (commit) =>
      granted(async () => {
        if (!COMMIT.test(commit)) {
          throw new HttpError(400, 'Send a full commit hash')
        }
        await changelogStore.markSeen(commit)
      }),
    start: async () =>
      granted(async () => {
        await recordRunningVersion(dir)
        startUpdateCheck(dir)
      }),
  }
}

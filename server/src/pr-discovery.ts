import { setTimeout as sleep } from 'node:timers/promises'
import { findPrUrls } from '@seti/shared'
import { tasks } from './db.js'
import { cachedPrHeads } from './github-cache.js'
import type { PrHead } from './github.js'
import { pushedHead, transcriptEvidence, type PrEvidence } from './pr-evidence.js'
import { prDiscoveryStore, prDismissals, type StoredRow } from './store/pr-discovery.js'
import { linkDiscoveredPr } from './tasks.js'

const BACKFILL_DELAY_MS = 10_000
/** Pause after each backfilled task that needed GitHub, so a large backlog stays gentle. */
const BACKFILL_GAP_MS = 2000

const OPENED = 'opened by the task'
const PUSHED = 'the task pushed its head branch'

/** Subagent reports and background task results that Claude Code stores as user text. */
const RELAYED = /<(?:agent-message|task-notification)[\s>]/

const typedByUser = (row: StoredRow) => row.kind === 'prompt' && !RELAYED.test(row.payload)

/** PR URLs in transcript rows, first appearance first; prompts the user typed are left out. */
export function prCandidates(rows: readonly StoredRow[]): string[] {
  return [...new Set(rows.flatMap((row) => (typedByUser(row) ? [] : findPrUrls(row.payload))))]
}

export interface PrDiscoveryDeps {
  cursor: (taskId: string) => Promise<number>
  setCursor: (taskId: string, messageId: number) => Promise<void>
  lastMessageId: (taskId: string) => Promise<number>
  rowsBetween: (taskId: string, after: number, upTo: number) => Promise<StoredRow[]>
  evidenceRows: (taskId: string, upTo: number) => Promise<StoredRow[]>
  linked: (taskId: string) => Promise<string[]>
  dismissed: (taskId: string) => Promise<Set<string>>
  fetch: (urls: readonly string[]) => Promise<Map<string, PrHead | null>>
  link: (taskId: string, url: string, found: string) => Promise<boolean>
  taskIds: () => Promise<string[]>
  onError: (error: unknown) => void
  sleep: (ms: number) => Promise<unknown>
}

/** Links PRs the transcript names only when the task's own calls opened or pushed to them. */
export function createPrDiscovery(deps: PrDiscoveryDeps) {
  const heads = new Map<string, PrHead | null>()
  const queues = new Map<string, Promise<boolean>>()

  async function headsOf(urls: readonly string[]): Promise<PrHead[]> {
    const missing = urls.filter((url) => !heads.has(url))
    if (missing.length > 0) {
      for (const [url, head] of await deps.fetch(missing)) {
        heads.set(url, head)
      }
    }
    return urls.map((url) => heads.get(url) ?? null).filter((head) => head !== null)
  }

  /** The candidates the task opened or pushed to, with how; `asks` when GitHub had to tell. */
  async function owned(urls: readonly string[], evidence: PrEvidence, skip: ReadonlySet<string>) {
    const found = new Map<string, string>()
    for (const url of urls) {
      if (evidence.created.has(url) || evidence.pushedTo.has(url)) {
        found.set(url, evidence.created.has(url) ? OPENED : PUSHED)
      }
    }
    const rest = urls.filter((url) => !found.has(url))
    if (rest.length === 0 || evidence.pushes.length === 0) {
      return { found, asks: false }
    }
    const asks = rest.some((url) => !heads.has(url))
    const pushed = (await headsOf(rest)).filter((pr) => pushedHead(pr, evidence.pushes) && !skip.has(pr.url))
    pushed.forEach((pr) => found.set(pr.url, PUSHED))
    return { found, asks }
  }

  /** Scans the task's new rows; true when it asked GitHub. The cursor moves only on success. */
  async function scan(taskId: string): Promise<boolean> {
    const after = await deps.cursor(taskId)
    const upTo = await deps.lastMessageId(taskId)
    if (upTo <= after) {
      return false
    }
    const skip = new Set([...(await deps.linked(taskId)), ...(await deps.dismissed(taskId))])
    const urls = prCandidates(await deps.rowsBetween(taskId, after, upTo)).filter((url) => !skip.has(url))
    let asks = false
    if (urls.length > 0) {
      const result = await owned(urls, transcriptEvidence(await deps.evidenceRows(taskId, upTo)), skip)
      asks = result.asks
      for (const [url, how] of result.found) {
        await deps.link(taskId, url, how)
      }
    }
    await deps.setCursor(taskId, upTo)
    return asks
  }

  /** Queues a scan of one task behind any scan of it already running; never rejects. */
  async function queue(taskId: string): Promise<boolean> {
    const next = (queues.get(taskId) ?? Promise.resolve(false))
      .then(async () => scan(taskId))
      .catch((e: unknown) => {
        deps.onError(e)
        return false
      })
    queues.set(taskId, next)
    void next.then(() => {
      if (queues.get(taskId) === next) {
        queues.delete(taskId)
      }
    })
    return next
  }

  async function backfill(): Promise<void> {
    try {
      for (const taskId of await deps.taskIds()) {
        if (await queue(taskId)) {
          await deps.sleep(BACKFILL_GAP_MS)
        }
      }
    } catch (e) {
      deps.onError(e)
    }
  }

  return {
    run: async (taskId: string): Promise<void> => {
      await queue(taskId)
    },
    backfill,
    /** Backfills every task once, in the background, a little after startup. */
    start: () => {
      void deps.sleep(BACKFILL_DELAY_MS).then(backfill)
    },
  }
}

let lastError = ''

export const prDiscovery = createPrDiscovery({
  ...prDiscoveryStore,
  linked: async (taskId) => (await tasks.get(taskId))?.pr_urls ?? [],
  dismissed: prDismissals.list,
  fetch: cachedPrHeads,
  link: linkDiscoveredPr,
  onError: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastError) {
      lastError = message
      process.stderr.write(`pr discovery: ${message}\n`)
    }
  },
  sleep,
})

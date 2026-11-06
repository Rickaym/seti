import type { PrComment, Preview } from '@seti/mod-api'

const BOT_LOGINS = new Set(['github-actions', 'github-actions[bot]'])
const READY = '## Preview Environment Ready'
const EXPIRED = '## Preview Environment Expired'
const URL_LINE = /\*\*Preview URL:\*\*\s*(\S+)/
const COMMIT_ROW = /^\|\s*Commit\s*\|\s*`([0-9a-f]{7,40})`\s*\|/im

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }

const heading = (body: string) => body.trimStart().split('\n', 1)[0]?.trim() ?? ''

function previewUrl(body: string): string | null {
  const raw = URL_LINE.exec(body)?.[1]
  return raw !== undefined && URL.canParse(raw) && new URL(raw).protocol === 'https:' ? new URL(raw).origin : null
}

/** Preview state from the most recently written Ready or Expired comment of the Actions bot. */
export function detectPreview(comments: readonly PrComment[], headOid: string): Preview {
  let latest: PrComment | undefined
  for (const comment of comments) {
    const relevant =
      comment.author !== null && BOT_LOGINS.has(comment.author) && [READY, EXPIRED].includes(heading(comment.body))
    if (relevant && (latest === undefined || comment.updatedAt >= latest.updatedAt)) {
      latest = comment
    }
  }
  if (latest === undefined) {
    return NO_PREVIEW
  }
  if (heading(latest.body) === EXPIRED) {
    return { ...NO_PREVIEW, state: 'expired' }
  }
  const url = previewUrl(latest.body)
  if (url === null) {
    return NO_PREVIEW
  }
  const commit = COMMIT_ROW.exec(latest.body)?.[1] ?? null
  return { state: 'ready', url, commit, stale: commit !== null && !headOid.startsWith(commit) }
}

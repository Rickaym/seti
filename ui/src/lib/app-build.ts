/** The build this page runs, from the tag the UI build writes into index.html; '' in development. */
export const pageBuild = (doc: Document): string =>
  doc.querySelector<HTMLMetaElement>('meta[name="seti-build"]')?.content ?? ''

/** The worker script of a build; its own address per build, so no cache can hand out an older one. */
export const workerScript = (build: string): string =>
  build === '' ? '/sw.js' : `/sw.js?build=${encodeURIComponent(build)}`

/** Whether the server hands out a build other than the one this page runs. */
export const isBehind = (page: string, server: string | null | undefined): boolean =>
  page !== '' && typeof server === 'string' && server !== '' && server !== page

/** What on the page a reload would cut short or throw away. */
export interface PageActivity {
  hidden: boolean
  /** A key or an edit came in the last few seconds. */
  typing: boolean
  /** A composer holds text; a reload brings it back. */
  draft: boolean
  /** Text a reload would lose, as in a composer that keeps no draft. */
  unkeptText: boolean
  dialog: boolean
  uploading: boolean
  /** A form holds changes that leaving would discard. */
  unsaved: boolean
}

/** now: reload into the new build. wait: offer Update and look again when the page settles. */
export function updateMoment(page: PageActivity): 'now' | 'wait' {
  if (page.uploading || page.unsaved || page.unkeptText) {
    return 'wait'
  }
  if (page.hidden) {
    return 'now'
  }
  return page.typing || page.draft || page.dialog ? 'wait' : 'now'
}

const FIRST_RETRY_MS = 5_000
const LAST_RETRY_MS = 300_000

/** How long to wait before the next try of an update that failed: 5 s, doubling, up to 5 minutes. */
export const retryDelay = (attempt: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1), LAST_RETRY_MS)

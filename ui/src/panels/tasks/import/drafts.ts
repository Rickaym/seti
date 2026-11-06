import type { ClaudeSession, ClaudeSessionDetail, ImportSessionInput } from '@seti/shared'

/** What the user changed for one session before importing it; unset fields use the defaults. */
export interface ImportDraft {
  title?: string
  /** The PR URLs to link; empty imports without any. */
  prs?: string[]
  /** A registered repo to run in instead of the session's own directory. */
  repoId?: string
}

export type Drafts = Record<string, ImportDraft>

export interface PrOption {
  url: string
  label: string
}

const PR_PARTS = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/

export function prLabel(url: string): string {
  const [, repo, number] = PR_PARTS.exec(url) ?? []
  return repo === undefined || number === undefined ? url : `${repo}#${number}`
}

/** PRs to offer for a session: created in it, open on its branch, then any it mentions. */
export function prOptions(row: ClaudeSession, detail: ClaudeSessionDetail | undefined): PrOption[] {
  const options: PrOption[] = []
  const add = (url: string, why: string) => {
    if (!options.some((option) => option.url === url)) {
      options.push({ url, label: `${prLabel(url)} (${why})` })
    }
  }
  const branch = 'open on its branch'
  const suggested = row.suggested_pr?.url
  for (const url of [...(detail?.created_prs ?? [])].reverse()) {
    add(url, url === suggested ? `created in session, ${branch}` : 'created in session')
  }
  if (suggested !== undefined) {
    add(suggested, branch)
  }
  for (const url of detail?.mentioned_prs ?? []) {
    add(url, 'mentioned')
  }
  return options
}

/** A title typed for the import; empty leaves it to the session's own title or the planner. */
const draftTitle = (draft: ImportDraft | undefined) => draft?.title?.trim() ?? ''

/** The PRs the import links; undefined while the detail is loading lets the server pick them. */
export const draftPrs = (
  detail: ClaudeSessionDetail | undefined,
  draft: ImportDraft | undefined,
): string[] | undefined => draft?.prs ?? detail?.default_pr_urls

/** Why this session cannot be imported as drafted, or null when it can. */
export function draftIssue(row: ClaudeSession, draft: ImportDraft | undefined): string | null {
  if (!row.cwd_exists && draft?.repoId === undefined) {
    return 'Pick a repo to continue in'
  }
  return null
}

export function importBody(
  detail: ClaudeSessionDetail | undefined,
  draft: ImportDraft | undefined,
  workspaceId: string | null,
): ImportSessionInput {
  const prs = draftPrs(detail, draft)
  const title = draftTitle(draft)
  return {
    ...(title === '' ? {} : { title }),
    ...(prs === undefined ? {} : { pr_urls: prs }),
    ...(draft?.repoId === undefined ? {} : { repo_id: draft.repoId }),
    ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
  }
}

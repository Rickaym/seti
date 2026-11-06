import { z } from 'zod'
import { prUrl } from './pr-url.js'
import type { CiState } from './prs.js'
import { workspaceId } from './workspaces.js'

export const SESSION_PAGE_MAX = 200
export const IMPORT_BATCH_MAX = 10

export const sessionListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SESSION_PAGE_MAX).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type SessionListQuery = z.output<typeof sessionListQuery>

export const sessionParams = z.object({ id: z.uuid() })

const importFields = {
  title: z.string().trim().min(1).max(200).optional(),
  /** PRs to link; omitted links every PR created in the session and the open PR of its branch. */
  pr_urls: z.array(prUrl).max(50).optional(),
  /** Runs the imported task in this repo instead of the session's recorded directory. */
  repo_id: z.uuid().optional(),
  /** Left out, the task joins the first workspace. */
  workspace_id: workspaceId.optional(),
}

export const importSessionInput = z.object(importFields)
export type ImportSessionInput = z.input<typeof importSessionInput>
export type ImportSessionRequest = z.output<typeof importSessionInput>

export const importSessionsInput = z.object({
  sessions: z
    .array(z.object({ session_id: z.uuid(), ...importFields }))
    .min(1, 'pick at least one session')
    .max(IMPORT_BATCH_MAX, `import at most ${String(IMPORT_BATCH_MAX)} sessions at once`)
    .refine((items) => new Set(items.map((item) => item.session_id)).size === items.length, 'sessions must be unique'),
})
export type ImportSessionsInput = z.input<typeof importSessionsInput>

/** An open PR of the session's repo whose head branch is the session's branch. */
export interface SuggestedPr {
  url: string
  key: string
  number: number
  title: string
  ci: CiState | null
  unresolved_threads: number
}

/** A Claude Code session started from a terminal or IDE on this machine. */
export interface ClaudeSession {
  id: string
  title: string
  cwd: string | null
  git_branch: string | null
  created_at: string | null
  last_modified: string
  size: number | null
  cwd_exists: boolean
  repo_id: string | null
  repo_slug: string | null
  suggested_pr: SuggestedPr | null
}

export interface ClaudeSessionPage {
  sessions: ClaudeSession[]
  /** Sessions matching the query, across all pages. */
  total: number
}

export interface ClaudeSessionDetail extends ClaudeSession {
  message_count: number
  first_at: string | null
  last_at: string | null
  /** URLs printed by `gh pr create` in the session, oldest first. */
  created_prs: string[]
  /** Other PR URLs that appear anywhere in the session. */
  mentioned_prs: string[]
  /** The PRs an import links when the request names none. */
  default_pr_urls: string[]
}

export interface SessionImportResult {
  session_id: string
  task_id: string | null
  error: string | null
}

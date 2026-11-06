/** One commit of the running Seti's history, its conventional subject split into parts. */
export interface ChangelogEntry {
  commit: string
  /** When it landed on the branch, as the committer date. */
  date: string
  /** The conventional type, such as feat or fix; null for a subject that does not follow it. */
  type: string | null
  scope: string | null
  breaking: boolean
  description: string
  pr: number | null
  body: string
  /** A feature, fix or speed-up; dependency bumps and upkeep are not. */
  notable: boolean
  /** Arrived with the running deploy, after the deploy before it. */
  current: boolean
  /** Arrived after the version the user last opened the changelog at. */
  unseen: boolean
}

/** The commit Seti runs, and when it was made. */
export interface SetiVersion {
  commit: string
  date: string
}

interface ChangelogNews {
  /** Null when Seti does not run from a git checkout. */
  version: SetiVersion | null
  /** Notable entries that arrived since the user last opened the changelog. */
  unseen: number
}

/** Current: the branch has nothing the running version lacks. Unknown: the check failed or waits. */
export type SetiUpdateState = 'current' | 'available' | 'unknown'

/** How the running version compares with the newest commit on the branch Seti updates from. */
export interface SetiUpdate {
  state: SetiUpdateState
  branch: string
  /** The branch's newest commit, once a check reached the remote. */
  latest: SetiVersion | null
  /** First-parent commits on the branch that the running version lacks. */
  behind: number | null
  /** Features, fixes and speed-ups among them. */
  notable: number | null
  checked_at: string | null
  /** Why the check could not tell. */
  error: string | null
  /** Shell lines that update this install. */
  command: string
}

export interface ChangelogStatus extends ChangelogNews {
  /** The last update check; null before the first one finished. */
  update: SetiUpdate | null
}

export interface Changelog extends ChangelogNews {
  /** Newest first. */
  entries: ChangelogEntry[]
  /** Older commits exist past the limit. */
  has_more: boolean
}

export const CHANGELOG_LIMIT_MAX = 500

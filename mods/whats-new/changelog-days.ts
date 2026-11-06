import type { ChangelogEntry } from '@seti/mod-api'

const SETI_REPO_URL = 'https://github.com/Rickaym/seti'

export const prUrl = (pr: number) => `${SETI_REPO_URL}/pull/${String(pr)}`
export const commitUrl = (commit: string) => `${SETI_REPO_URL}/commit/${commit}`
export const compareUrl = (from: string, to: string) => `${SETI_REPO_URL}/compare/${from}...${to}`
export const shortCommit = (commit: string) => commit.slice(0, 7)

/** Joins the class names that apply. */
export const cn = (...names: (string | false | null | undefined)[]) =>
  names.filter((name) => typeof name === 'string' && name !== '').join(' ')

const TYPE_LABELS: Record<string, string> = {
  feat: 'Feature',
  fix: 'Fix',
  perf: 'Perf',
  refactor: 'Refactor',
  docs: 'Docs',
  test: 'Tests',
  ci: 'CI',
  build: 'Build',
  chore: 'Chore',
  revert: 'Revert',
  style: 'Style',
}

export const typeLabel = (type: string | null) => (type === null ? 'Other' : (TYPE_LABELS[type] ?? type))

export interface ChangelogDay {
  /** The local calendar day, as YYYY-MM-DD. */
  key: string
  label: string
  entries: ChangelogEntry[]
}

const pad = (n: number) => String(n).padStart(2, '0')

const localDay = (date: Date) => `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function dayLabel(date: Date, now: Date): string {
  const key = localDay(date)
  if (key === localDay(now)) {
    return 'Today'
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === localDay(yesterday)) {
    return 'Yesterday'
  }
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year })
}

/** Entries by the local day they landed, newest first; `all` keeps upkeep as well. */
export function changelogDays(entries: readonly ChangelogEntry[], all: boolean, now = new Date()): ChangelogDay[] {
  const days: ChangelogDay[] = []
  for (const entry of entries) {
    if (!all && !entry.notable) {
      continue
    }
    const date = new Date(entry.date)
    const key = localDay(date)
    const last = days.at(-1)
    if (last?.key === key) {
      last.entries.push(entry)
    } else {
      days.push({ key, label: dayLabel(date, now), entries: [entry] })
    }
  }
  return days
}

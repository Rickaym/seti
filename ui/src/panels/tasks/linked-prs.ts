import type { LinkedPrState, PullRequest } from '@seti/shared'
import { prShortLabel } from '@/lib/pr-number'
import { needsFix } from '@/panels/tasks/pr-ci'

/** Where a linked PR stands: `fix` is open with failing CI or conflicts. */
export type LinkedPrGroup = 'fix' | 'open' | 'merged' | 'closed'

export const LINKED_PR_GROUPS: readonly LinkedPrGroup[] = ['fix', 'open', 'merged', 'closed']

export interface LinkedPr {
  url: string
  /** `#12` for the agent's own repo, `repo#12` for another. */
  label: string
  /** `owner/repo` from the URL, so PRs Seti has no status for still filter by repo. */
  slug: string
  number: number
  /** Live status while the PR is open in a registered repo. */
  pr: PullRequest | null
  group: LinkedPrGroup
  /** Position in link order; later links count as more recent when no update time is known. */
  linked: number
}

const URL_PARTS = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/

function groupOf(pr: PullRequest | null, state: LinkedPrState | undefined): LinkedPrGroup {
  if (pr !== null) {
    return needsFix(pr) ? 'fix' : 'open'
  }
  return state ?? 'open'
}

const RANK: Record<LinkedPrGroup, number> = { fix: 0, open: 1, merged: 2, closed: 3 }

function byRelevance(a: LinkedPr, b: LinkedPr): number {
  const rank = RANK[a.group] - RANK[b.group]
  if (rank !== 0) {
    return rank
  }
  const updated = (b.pr?.updated_at ?? '').localeCompare(a.pr?.updated_at ?? '')
  return updated === 0 ? b.linked - a.linked : updated
}

/** Linked PRs to fix first, then open, merged and closed; the most recent first within each. */
export function orderLinkedPrs(
  urls: readonly string[],
  statuses: ReadonlyMap<string, PullRequest>,
  states: Readonly<Record<string, LinkedPrState>>,
  homeSlug: string | null,
): LinkedPr[] {
  return urls
    .map((url, linked) => {
      const [, slug = '', number = '0'] = URL_PARTS.exec(url) ?? []
      const pr = statuses.get(url) ?? null
      return {
        url,
        label: prShortLabel(url, homeSlug),
        slug,
        number: Number(number),
        pr,
        group: groupOf(pr, states[url]),
        linked,
      }
    })
    .toSorted(byRelevance)
}

/** Every word of the query must match the PR's number, label, repo or title, ignoring case. */
export function filterLinkedPrs(prs: readonly LinkedPr[], query: string): readonly LinkedPr[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return prs
  }
  return prs.filter((item) => {
    const haystack = `#${String(item.number)} ${item.label} ${item.slug} ${item.pr?.title ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

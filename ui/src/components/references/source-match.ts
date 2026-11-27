import type { SourceMatch } from '@seti/shared'
import { useContext } from 'react'
import { ReferencesContext } from '@/components/references/reference-context'
import type { Reference } from '@/lib/references/reference-set'
import { useSourceMatches } from '@/lib/references/source-matches'

/** What a link at a branch name matched: the commit that branch was at when the agent read it. */
export const asReadAt = (commit: string) => `as read at ${commit}`

/** What the agent's ledger says of one reference of the message being rendered; null when silent. */
export function useSourceMatch(reference: Reference): SourceMatch | null {
  const set = useContext(ReferencesContext)
  const matches = useSourceMatches(set?.refs ?? [])
  return reference.href === null ? null : (matches.get(reference.href) ?? null)
}

const sourceDay = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Where and when the source was written, as the ledger states it: `#release, 24 Nov 2025`, or
 * only the day when the label already names the place.
 */
export function sourceFacts(match: SourceMatch | null, label: string): string | null {
  const source = match?.source
  if (source === undefined || source === null) {
    return null
  }
  const parts = [
    label.includes(source.place) ? null : source.place,
    source.at === null ? null : sourceDay(source.at),
    match?.as_read_at === undefined ? null : asReadAt(match.as_read_at),
  ]
  const shown = parts.filter((part) => part !== null)
  return shown.length === 0 ? null : shown.join(', ')
}

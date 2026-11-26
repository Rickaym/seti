import type { SourceMatch } from '@seti/shared'
import { useContext } from 'react'
import { ReferencesContext } from '@/components/references/reference-context'
import type { Reference } from '@/lib/references/reference-set'
import { useSourceMatches } from '@/lib/references/source-matches'

/** What the agent's ledger says of one reference of the message being rendered; null when silent. */
export function useSourceMatch(reference: Reference): SourceMatch | null {
  const set = useContext(ReferencesContext)
  const matches = useSourceMatches(set?.refs ?? [])
  return reference.href === null ? null : (matches.get(reference.href) ?? null)
}

const sourceDay = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Where and when the source was written, as the ledger states it: `#release, 24 Nov 2025`. */
export function sourceFacts(match: SourceMatch | null): string | null {
  const source = match?.source
  if (source === undefined || source === null) {
    return null
  }
  return source.at === null ? source.place : `${source.place}, ${sourceDay(source.at)}`
}

import type { AgentColor, TaskDisplayStatus } from '@seti/shared'
import type { ComponentType } from 'react'
import { matchFields } from './fuzzy'

/** One row of the palette: a place or a command, already bound to what it does. */
export interface PaletteEntry {
  id: string
  group: string
  title: string
  detail?: string | undefined
  detailTitle?: string | undefined
  keywords?: string | undefined
  icon: ComponentType<{ className?: string }>
  status?: TaskDisplayStatus | 'archived' | undefined
  color?: AgentColor | null | undefined
  shortcut?: string | undefined
  run: () => void
}

export interface RankedEntry {
  entry: PaletteEntry
  /** Matched positions in the title and in the detail line. */
  title: readonly number[]
  detail: readonly number[]
}

export interface EntryGroup {
  heading: string
  items: RankedEntry[]
}

export const RECENT_HEADING = 'Recent'
const RECENT_SHOWN = 5
const RECENT_BOOST = 0.5

const unmatched = (entry: PaletteEntry): RankedEntry => ({ entry, title: [], detail: [] })

function grouped(items: readonly RankedEntry[], cap: number): EntryGroup[] {
  const groups = new Map<string, RankedEntry[]>()
  for (const item of items) {
    const list = groups.get(item.entry.group) ?? []
    if (list.length < cap) {
      list.push(item)
    }
    groups.set(item.entry.group, list)
  }
  return [...groups].map(([heading, list]) => ({ heading, items: list }))
}

/**
 * The empty query: recent entries first, then the entries of `groups` (all when omitted) in
 * their order, at most `cap` rows per group.
 */
export function browse(
  entries: readonly PaletteEntry[],
  recent: readonly string[],
  { cap, groups }: { cap: number; groups?: readonly string[] },
): EntryGroup[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const recentEntries = recent
    .flatMap((id) => {
      const entry = byId.get(id)
      return entry === undefined ? [] : [entry]
    })
    .slice(0, RECENT_SHOWN)
  const shown = new Set(recentEntries.map((entry) => entry.id))
  const rest = grouped(
    entries.filter((entry) => !shown.has(entry.id) && (groups?.includes(entry.group) ?? true)).map(unmatched),
    cap,
  )
  return recentEntries.length === 0 ? rest : [{ heading: RECENT_HEADING, items: recentEntries.map(unmatched) }, ...rest]
}

/**
 * Entries matching every term of `query`, best first, with a nudge for recent ones; groups
 * follow their best match, and only the top `limit` rows are kept.
 */
export function search(
  query: string,
  entries: readonly PaletteEntry[],
  recent: readonly string[],
  limit: number,
): EntryGroup[] {
  const scored = entries.flatMap((entry, index) => {
    const match = matchFields(query, [entry.title, entry.detail ?? '', entry.keywords ?? ''])
    if (match === null) {
      return []
    }
    const recency = recent.indexOf(entry.id)
    const boost = recency === -1 ? 0 : RECENT_BOOST / (recency + 1)
    return [
      {
        index,
        score: match.score + boost,
        item: { entry, title: match.positions[0] ?? [], detail: match.positions[1] ?? [] },
      },
    ]
  })
  scored.sort((a, b) => (a.score === b.score ? a.index - b.index : b.score - a.score))
  return grouped(
    scored.slice(0, limit).map(({ item }) => item),
    limit,
  )
}

import type { ModTranscriptBlock } from '@seti/mod-api'
import { useMemo, useSyncExternalStore } from 'react'
import { transcriptBlockSources, type TimedBlock, type TranscriptBlockEntry } from '@/lib/transcript-blocks'

/** Runs a mod's call, so one failing source drops only its own blocks. */
function guarded<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const NONE: readonly TimedBlock[] = []
const NO_LIST: readonly ModTranscriptBlock[] = []

const timed = (entry: TranscriptBlockEntry, list: readonly ModTranscriptBlock[]): TimedBlock[] =>
  list.map((block) => ({ key: `${entry.key}:${block.id}`, id: block.id, at: Date.parse(block.at), entry }))

/**
 * The agent's blocks from every source, watched while anything reads them. The snapshot keeps its
 * identity until a source hands over a new list for this agent, so another agent's change, or a
 * load that found nothing, renders nothing here.
 */
function blockStore(entries: readonly TranscriptBlockEntry[], agent: string) {
  let lists: readonly (readonly ModTranscriptBlock[])[] = []
  let snapshot = NONE
  const collect = (): boolean => {
    const next = entries.map((entry) => guarded(() => entry.source.blocks(agent), NO_LIST))
    if (next.length === lists.length && next.every((list, i) => list === lists[i])) {
      return false
    }
    lists = next
    const blocks = entries.flatMap((entry, i) => timed(entry, next[i] ?? NO_LIST))
    const changed = blocks.length > 0 || snapshot.length > 0
    snapshot = blocks.length === 0 ? NONE : blocks
    return changed
  }
  collect()
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      const changed = () => {
        if (collect()) {
          listener()
        }
      }
      const ends = entries.flatMap((entry) => [
        guarded(
          () => entry.source.subscribe(agent, changed),
          () => undefined,
        ),
        guarded(
          () => entry.source.watch(agent),
          () => undefined,
        ),
      ])
      changed()
      return () => {
        for (const end of ends) {
          guarded(end, undefined)
        }
      }
    },
  }
}

/** The blocks enabled mods draw in the agent's transcript, following them while it shows. */
export function useTranscriptBlocks(agent: string): readonly TimedBlock[] {
  const entries = useSyncExternalStore(transcriptBlockSources.subscribe, transcriptBlockSources.list)
  const store = useMemo(() => blockStore(entries, agent), [entries, agent])
  return useSyncExternalStore(store.subscribe, store.get)
}

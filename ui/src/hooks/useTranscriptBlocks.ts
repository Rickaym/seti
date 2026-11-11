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

const blocksOf = (entry: TranscriptBlockEntry, agent: string): TimedBlock[] =>
  guarded(() => entry.source.blocks(agent), []).map((block) => ({
    key: `${entry.key}:${block.id}`,
    id: block.id,
    at: Date.parse(block.at),
    entry,
  }))

/** The agent's blocks from every source, watched while anything reads them. */
function blockStore(entries: readonly TranscriptBlockEntry[], agent: string) {
  const collect = (): readonly TimedBlock[] => entries.flatMap((entry) => blocksOf(entry, agent))
  let snapshot = collect()
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      const changed = () => {
        snapshot = collect()
        listener()
      }
      const ends = entries.flatMap((entry) => [
        guarded(
          () => entry.source.subscribe(changed),
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

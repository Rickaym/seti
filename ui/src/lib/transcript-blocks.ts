import type { ModTranscriptSource } from '@seti/mod-api'
import { Registry, type MessageRow } from '@seti/shared'
import type { TranscriptView } from '@/lib/tool-groups'

/** A source of blocks an enabled mod draws inline in agents' transcripts. */
export interface TranscriptBlockEntry {
  key: string
  mod: string
  name: string
  source: ModTranscriptSource
}

export const transcriptBlockSources = new Registry<TranscriptBlockEntry>('transcript block', (entry) => entry.key)

/** Tells the sources of `mod` that its blocks in the agent's transcript changed. */
export function refreshTranscriptBlocks(agent: string, mod: string): void {
  for (const entry of transcriptBlockSources.list()) {
    if (entry.mod === mod) {
      try {
        entry.source.refresh(agent)
      } catch {
        // A mod's failing refresh leaves its blocks as they were.
      }
    }
  }
}

/** One block to draw: the source that keeps it, its id there and when it happened. */
export interface TimedBlock {
  key: string
  id: string
  at: number
  entry: TranscriptBlockEntry
}

/** A row a block can sit before, with the time it was stored. */
interface Anchor {
  id: number
  at: number
}

/** Where blocks go: before the view that starts with a row, or after the last one. */
export interface PlacedBlocks {
  before: ReadonlyMap<number, readonly TimedBlock[]>
  after: readonly TimedBlock[]
}

export const NO_BLOCKS: PlacedBlocks = { before: new Map(), after: [] }

/** The row a view of the transcript starts with; a rewind note has none. */
export function viewStart(view: TranscriptView): MessageRow | undefined {
  switch (view.type) {
    case 'row':
      return view.row
    case 'note':
      return undefined
    case 'tools':
    case 'rewound':
      return view.rows[0]
  }
}

/** The first row of each view of the transcript, which a block can sit before. */
export function anchorsOf(views: readonly TranscriptView[]): Anchor[] {
  return views.flatMap((view) => {
    const row = viewStart(view)
    return row === undefined ? [] : [{ id: row.id, at: Date.parse(row.created_at) }]
  })
}

/** What the loaded rows leave out: rows before them, and rows after them. */
export interface LoadedEdges {
  hasOlder: boolean
  hasNewer: boolean
}

/**
 * Places each block before the first view that started after it, or after the last view. A block
 * from before the loaded rows waits for the earlier page, and one after them for the later one.
 */
export function placeBlocks(
  anchors: readonly Anchor[],
  blocks: readonly TimedBlock[],
  edges: LoadedEdges,
): PlacedBlocks {
  if (blocks.length === 0) {
    return NO_BLOCKS
  }
  const before = new Map<number, TimedBlock[]>()
  const after: TimedBlock[] = []
  for (const block of blocks.toSorted((a, b) => a.at - b.at)) {
    const index = anchors.findIndex((anchor) => anchor.at > block.at)
    const anchor = anchors[index]
    if (anchor === undefined) {
      if (!edges.hasNewer) {
        after.push(block)
      }
    } else if (index > 0 || !edges.hasOlder) {
      before.set(anchor.id, [...(before.get(anchor.id) ?? []), block])
    }
  }
  return { before, after }
}

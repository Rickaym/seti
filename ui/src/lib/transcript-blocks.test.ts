import type { ModTranscriptSource } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import {
  placeBlocks,
  refreshTranscriptBlocks,
  transcriptBlockSources,
  type TimedBlock,
  type TranscriptBlockEntry,
} from '@/lib/transcript-blocks'

const source = (refresh = vi.fn()): ModTranscriptSource => ({
  id: 'asides',
  watch: () => () => undefined,
  blocks: () => [],
  subscribe: () => () => undefined,
  refresh,
  view: () => null,
})

const entry: TranscriptBlockEntry = { key: 'side-chat.asides', mod: 'side-chat', name: 'Asides', source: source() }
const block = (id: string, at: number): TimedBlock => ({ key: id, id, at, entry })
const anchors = [
  { id: 10, at: 100 },
  { id: 11, at: 200 },
  { id: 12, at: 300 },
]
const ids = (blocks: readonly TimedBlock[] | undefined) => blocks?.map((b) => b.id)

describe('placing transcript blocks', () => {
  it('puts each block before the first row that came after it, in time order', () => {
    const placed = placeBlocks(anchors, [block('late', 250), block('early', 150), block('mid', 199)], {
      hasOlder: false,
      hasNewer: false,
    })
    expect(ids(placed.before.get(11))).toEqual(['early', 'mid'])
    expect(ids(placed.before.get(12))).toEqual(['late'])
    expect(placed.after).toEqual([])
  })

  it('puts blocks after the newest row last, and before the oldest first once nothing is older', () => {
    const placed = placeBlocks(anchors, [block('first', 50), block('last', 400)], { hasOlder: false, hasNewer: false })
    expect(ids(placed.before.get(10))).toEqual(['first'])
    expect(ids(placed.after)).toEqual(['last'])
  })

  it('leaves blocks outside the loaded rows to the pages that hold them', () => {
    const placed = placeBlocks(anchors, [block('older', 50), block('newer', 400)], { hasOlder: true, hasNewer: true })
    expect(placed.before.size).toBe(0)
    expect(placed.after).toEqual([])
  })

  it('shows every block of a transcript with no rows yet', () => {
    expect(ids(placeBlocks([], [block('only', 1)], { hasOlder: false, hasNewer: false }).after)).toEqual(['only'])
  })
})

describe('refreshing transcript blocks', () => {
  it("refreshes the named mod's sources only", () => {
    const mine = vi.fn()
    const theirs = vi.fn()
    const stops = [
      transcriptBlockSources.register({ ...entry, source: source(mine) }),
      transcriptBlockSources.register({ key: 'notes.notes', mod: 'notes', name: 'Notes', source: source(theirs) }),
    ]
    refreshTranscriptBlocks('t1', 'side-chat')
    expect(mine).toHaveBeenCalledWith('t1')
    expect(theirs).not.toHaveBeenCalled()
    refreshTranscriptBlocks('t1', 'notes')
    expect(theirs).toHaveBeenCalledWith('t1')
    for (const stop of stops) {
      stop()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { compactionGaps } from './compaction-gaps'

describe("a runtime's compaction gaps", () => {
  it('says nothing for a runtime that honours the whole rule, and names each part another does not', () => {
    expect(compactionGaps('Claude Code', [])).toBeNull()
    expect(compactionGaps('Codex', ['off', 'window'])).toBe(
      'Codex compacts near its own limit even with Auto compact off, and uses a Context window only together with Compact at.',
    )
  })
})

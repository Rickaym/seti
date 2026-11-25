import type { CompactPart } from '@seti/shared'

const GAPS: Record<CompactPart, string> = {
  off: 'compacts near its own limit even with Auto compact off',
  window: 'uses a Context window only together with Compact at',
}

/** What of a compaction rule a runtime does not honour, in one sentence; null when it honours all. */
export function compactionGaps(label: string, parts: readonly CompactPart[]): string | null {
  return parts.length === 0 ? null : `${label} ${parts.map((part) => GAPS[part]).join(', and ')}.`
}

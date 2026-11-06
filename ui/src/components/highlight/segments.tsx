import type { Segment } from '@seti/shared/highlight'
import type { ReactNode } from 'react'

/** Runs of code as plain text and token spans. */
export function renderSegments(segments: readonly Segment[]): ReactNode[] {
  return segments.map((segment, n) =>
    segment.className === '' ? (
      segment.text
    ) : (
      <span key={n} className={segment.className}>
        {segment.text}
      </span>
    ),
  )
}

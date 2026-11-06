import { Mic } from 'lucide-react'
import type { ReactNode } from 'react'

/** A divider shown before a row, such as where a call started. */
export interface TranscriptNote {
  text: string
  /** More behind the divider, shown on hover. */
  detail?: string
}

/** Rows spoken on a call, and dividers before rows; the EA chat marks its transcript this way. */
export interface TranscriptMarks {
  voice: ReadonlySet<number>
  notes: ReadonlyMap<number, TranscriptNote>
}

export function NoteLine({ note }: { note: TranscriptNote }) {
  return (
    <div
      className="flex items-center gap-3 text-2xs tracking-wider text-muted-foreground uppercase"
      title={note.detail}
      data-note=""
    >
      <span className="h-px flex-1 bg-border" />
      <span>{note.text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** Marks a message that was spoken on a call rather than typed. */
export function Spoken({ voice, children }: { voice: boolean; children: ReactNode }) {
  if (!voice) {
    return <>{children}</>
  }
  return (
    <div className="flex gap-2" data-voice="">
      <Mic className="mt-1 size-3 shrink-0 text-muted-foreground" aria-label="Spoken on a call" role="img" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

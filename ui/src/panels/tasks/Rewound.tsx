import type { MessageRow, TaskRewind } from '@seti/shared'
import { ChevronDown, ChevronRight, History } from 'lucide-react'
import { useContext, useState, type ReactNode } from 'react'
import { FindFocusContext } from '@/hooks/useFindMarks'
import { cn } from '@/lib/utils'

const preview = (text: string) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}...` : line
}

const fileCount = (files: readonly string[]) => (files.length === 1 ? '1 file' : `${String(files.length)} files`)

function stateNote(rewind: TaskRewind): string {
  const parts = [
    ...(rewind.files_changed.length > 0 ? [`${fileCount(rewind.files_changed)} restored`] : []),
    ...(rewind.state === 'pending' ? ['the next message continues from here'] : []),
  ]
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/** The rows one conversation rewind took out of the agent's context, folded until opened. */
export function RewoundGroup({
  rewind,
  rows,
  count,
  children,
}: {
  rewind: TaskRewind
  rows: readonly MessageRow[]
  count: number
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const focusId = useContext(FindFocusContext)
  const open = expanded || rows.some((row) => row.id === focusId)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="border border-dashed border-warning/60" data-rewound={rewind.id}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-warning/10 px-3 py-1.5 text-left text-xs"
        onClick={() => {
          setExpanded((value) => !value)
        }}
      >
        <Chevron className="size-3.5 shrink-0" />
        <History className="size-3.5 shrink-0 text-warning-text" />
        <span className="min-w-0 truncate">
          <span className="font-medium">
            {count} {count === 1 ? 'message' : 'messages'} rewound
          </span>
          <span className="text-muted-foreground">
            {' '}
            to before &quot;{preview(rewind.prompt_text)}&quot;{stateNote(rewind)}
          </span>
        </span>
      </button>
      {open && <div className="space-y-3 px-3 py-3 opacity-60">{children}</div>}
    </div>
  )
}

/** A rewind that folded nothing: a code restore, or one Claude Code refused. */
export function RewindNote({ rewind }: { rewind: TaskRewind }) {
  const refused = rewind.state === 'refused'
  const text = refused
    ? `Rewind to before "${preview(rewind.prompt_text)}" was refused by Claude Code, so the agent kept the full conversation: ${rewind.reason ?? 'no reason given'}`
    : `Restored ${fileCount(rewind.files_changed)} to before "${preview(rewind.prompt_text)}"`
  return (
    <div
      className={cn('flex items-center gap-2 text-xs text-muted-foreground', refused && 'text-warning-text')}
      data-rewind-note={rewind.id}
      title={rewind.files_changed.join('\n')}
    >
      <History className="size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </div>
  )
}

import type { RevisionValue } from '@seti/shared'
import { foldUnchanged, lineDiff, type DiffRow } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { fieldLabel } from './format'

const LONG_TEXT = 80

const isLongText = (value: RevisionValue | undefined) =>
  typeof value === 'string' && (value.includes('\n') || value.length > LONG_TEXT)

function plain(value: RevisionValue | undefined): string {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return '(none)'
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }
  return Array.isArray(value) ? value.join(', ') : String(value)
}

const ROW_STYLE = {
  same: 'text-muted-foreground',
  add: 'bg-diff-add/15 text-foreground',
  del: 'bg-diff-del/10 text-diff-del',
} as const

const ROW_MARK = { same: ' ', add: '+', del: '-' } as const

function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === 'skip') {
    return (
      <div className="px-2 text-muted-foreground/70 italic select-none">
        ... {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
      </div>
    )
  }
  return (
    <div className={cn('px-2 whitespace-pre-wrap', ROW_STYLE[row.kind])} data-diff={row.kind}>
      <span className="mr-2 select-none">{ROW_MARK[row.kind]}</span>
      {row.text === '' ? ' ' : row.text}
    </div>
  )
}

function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = foldUnchanged(lineDiff(before, after))
  return (
    <div className="max-h-72 overflow-auto border border-border bg-muted/30 py-1 font-mono text-2xs leading-relaxed break-all">
      {rows.map((row, index) => (
        <DiffRowView key={String(index)} row={row} />
      ))}
    </div>
  )
}

export function FieldChange({
  field,
  before,
  after,
}: {
  field: string
  before: RevisionValue | undefined
  after: RevisionValue | undefined
}) {
  let change
  if (isLongText(before) || isLongText(after)) {
    change = (
      <LineDiff before={typeof before === 'string' ? before : ''} after={typeof after === 'string' ? after : ''} />
    )
  } else {
    change = (
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground line-through">{plain(before)}</span>
        <span aria-hidden>to</span>
        <span className="font-medium">{plain(after)}</span>
      </span>
    )
  }
  return (
    <div className="space-y-1" data-field={field}>
      <div className="text-2xs font-semibold text-muted-foreground">{fieldLabel(field)}</div>
      {change}
    </div>
  )
}

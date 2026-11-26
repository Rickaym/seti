import { cn } from '@/lib/utils'
import type { SuggestionRow } from './suggestion-rows'

function Suggestion({
  id,
  row,
  active,
  onPick,
}: {
  id: string
  row: SuggestionRow
  active: boolean
  onPick: () => void
}) {
  const off = row.unavailable !== null
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={off}
      className={cn(
        'grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-x-3 px-2 py-1 max-md:grid-cols-1 pointer-coarse:min-h-11 pointer-coarse:content-center',
        off ? 'cursor-default text-muted-foreground' : 'cursor-pointer',
        active && 'bg-accent text-accent-foreground',
      )}
      onMouseDown={(e) => {
        e.preventDefault()
        if (!off) {
          onPick()
        }
      }}
    >
      <span className="min-w-0 truncate">
        <span className={cn(!off && 'font-medium')}>{row.title}</span>
        {row.hint !== '' && <span className="ml-1.5 text-muted-foreground">{row.hint}</span>}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{row.unavailable ?? row.detail}</span>
    </div>
  )
}

/** The commands that match the first word, or the choices for the word being typed. */
export function SuggestionList({
  listId,
  label,
  rows,
  active,
  loading,
  updating,
  placement,
  onPick,
  heading,
}: {
  listId: string
  label: string
  /** One line over a word's choices saying what to pick; none over the commands. */
  heading?: string | undefined
  rows: readonly SuggestionRow[]
  active: number
  loading: boolean
  updating: boolean
  placement: 'above' | 'below'
  onPick: (row: SuggestionRow) => void
}) {
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={label}
      className={cn(
        'z-20 max-h-72 w-full overflow-y-auto border border-border bg-popover py-1 text-xs text-popover-foreground shadow-md',
        placement === 'above' ? 'absolute bottom-full left-0 mb-1' : 'mt-1',
      )}
    >
      {heading !== undefined && <div className="px-2 py-1 text-2xs text-muted-foreground">{heading}</div>}
      {rows.map((row, index) => (
        <Suggestion
          key={row.key}
          id={`${listId}-${String(index)}`}
          row={row}
          active={index === active}
          onPick={() => {
            onPick(row)
          }}
        />
      ))}
      {rows.length === 0 && (
        <div className="px-2 py-1 text-muted-foreground">
          {loading ? 'Loading commands...' : 'No matching commands'}
        </div>
      )}
      {updating && (
        <div className="px-2 pt-1 text-2xs text-muted-foreground italic">Updating the list for this directory...</div>
      )}
    </div>
  )
}

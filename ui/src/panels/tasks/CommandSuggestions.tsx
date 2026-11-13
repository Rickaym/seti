import type { ComposerCommand } from '@seti/shared'
import { cn } from '@/lib/utils'

function Suggestion({
  id,
  command,
  active,
  onPick,
}: {
  id: string
  command: ComposerCommand
  active: boolean
  onPick: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      className={cn(
        'grid cursor-pointer grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-x-3 px-2 py-1 max-md:grid-cols-1',
        active && 'bg-accent text-accent-foreground',
      )}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
    >
      <span className="min-w-0 truncate">
        <span className="font-medium">/{command.name}</span>
        {command.argument_hint !== '' && <span className="ml-1.5 text-muted-foreground">{command.argument_hint}</span>}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {command.unsupported === null ? command.description : `Not supported in Seti: ${command.unsupported}`}
      </span>
    </div>
  )
}

/** The slash commands that match the first word, under or over the box. */
export function SuggestionList({
  listId,
  items,
  active,
  loading,
  updating,
  placement,
  onPick,
}: {
  listId: string
  items: readonly ComposerCommand[]
  active: number
  loading: boolean
  updating: boolean
  placement: 'above' | 'below'
  onPick: (command: ComposerCommand) => void
}) {
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Command suggestions"
      className={cn(
        'z-20 max-h-72 w-full overflow-y-auto border border-border bg-popover py-1 text-xs text-popover-foreground shadow-md',
        placement === 'above' ? 'absolute bottom-full left-0 mb-1' : 'mt-1',
      )}
    >
      {items.map((command, index) => (
        <Suggestion
          key={command.name}
          id={`${listId}-${String(index)}`}
          command={command}
          active={index === active}
          onPick={() => {
            onPick(command)
          }}
        />
      ))}
      {items.length === 0 && (
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

import { Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Hint } from '@/components/Hint'
import { chordAria, chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FilterProps {
  query: string
  onQuery: (query: string) => void
  /** Focuses and selects the field as it appears and each time this changes, as Alt+/ does. */
  focusTick: number
  /** Hides the field, from Esc on an empty query. */
  onClose: () => void
}

/** Narrows the list by title, repo or status words; Esc clears it, then closes it. */
export function AgentFilter({ query, onQuery, focusTick, onClose }: FilterProps) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusTick])
  return (
    <div className="relative border-b border-border px-3 py-1.5">
      <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        type="search"
        aria-label="Filter agents"
        aria-keyshortcuts={chordAria(CHORDS.filterAgents)}
        placeholder="Filter by title, repo or status"
        className="h-7 pr-7 pl-7 [&::-webkit-search-cancel-button]:hidden"
        value={query}
        onChange={(e) => {
          onQuery(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') {
            return
          }
          e.preventDefault()
          if (query === '') {
            e.currentTarget.blur()
            onClose()
          } else {
            onQuery('')
          }
        }}
      />
      {query !== '' && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Clear filter"
          className="absolute top-1/2 right-4 -translate-y-1/2"
          onClick={() => {
            onQuery('')
            input.current?.focus()
          }}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

/** Shows or hides the agent filter, which stays hidden until asked for. */
export function AgentSearchButton({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <Hint text={`Filter agents (${chordLabel(CHORDS.filterAgents)})`}>
      <Button
        size="icon-sm"
        variant={open ? 'secondary' : 'ghost'}
        aria-label="Filter agents"
        aria-pressed={open}
        aria-keyshortcuts={chordAria(CHORDS.filterAgents)}
        onClick={() => {
          onOpen(!open)
        }}
      >
        <Search />
      </Button>
    </Hint>
  )
}

import { ChevronDown, ChevronUp, Search, WholeWord, Wrench, X } from 'lucide-react'
import { useEffect, useRef, type MouseEvent } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { FIND_SHORTCUT } from '@/components/shortcuts/find'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { findCount, type ChatFind } from '@/hooks/useChatFind'
import { hookTakesFindEnter } from '@/lib/input-hooks'
import { cn } from '@/lib/utils'
import { WIDE_BUTTON, WIDE_LABEL } from '@/lib/wide-label'

/** Stepping by mouse leaves focus in the field, so Enter keeps stepping and typing keeps editing. */
const keepTyping = (e: MouseEvent) => {
  e.preventDefault()
}

interface FindBarProps {
  find: ChatFind
  onClose: () => void
  className?: string
}

/** Find in one chat while it is open: the query, how many hits, stepping through them, closing. */
export function ChatFindBar(props: FindBarProps) {
  return props.find.open ? <FindBar {...props} /> : null
}

function FindBar({ find, onClose, className }: FindBarProps) {
  const field = useRef<HTMLInputElement>(null)
  const count = findCount(find)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [find.focusRequest])

  return (
    <div
      role="search"
      data-testid="chat-find"
      className={cn('flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-1.5', className)}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={field}
        type="search"
        value={find.query}
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        data-testid="chat-find-input"
        className="h-7 min-w-0 flex-1 border-none bg-transparent focus-visible:ring-0 dark:bg-transparent"
        onChange={(e) => {
          find.setQuery(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (hookTakesFindEnter(e.currentTarget, e)) {
              return
            }
            if (e.shiftKey) {
              find.newer()
            } else {
              find.older()
            }
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span
        aria-live="polite"
        data-testid="chat-find-count"
        className={cn(
          'shrink-0 text-2xs text-muted-foreground tabular-nums',
          find.error !== null && 'text-destructive',
        )}
        title={find.error ?? undefined}
      >
        {find.error === null ? count : 'Search failed'}
      </span>
      <ToggleButton
        pressed={find.mode === 'words'}
        onPressedChange={(words) => {
          find.setMode(words ? 'words' : 'text')
        }}
        icon={WholeWord}
        label="Whole words"
        iconOnly
        hint="Whole words, in any order"
      />
      {find.tools !== null && (
        <ToggleButton
          pressed={find.tools}
          onPressedChange={find.setTools}
          icon={Wrench}
          label="Tools"
          hint="Search tool calls and their output too, not only messages and replies"
        />
      )}
      <Hint text="Older match (Enter)">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Older match"
          disabled={find.hits.length === 0}
          onMouseDown={keepTyping}
          onClick={find.older}
        >
          <ChevronUp />
        </Button>
      </Hint>
      <Hint text="Newer match (Shift+Enter)">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Newer match"
          disabled={find.hits.length === 0}
          onMouseDown={keepTyping}
          onClick={find.newer}
        >
          <ChevronDown />
        </Button>
      </Hint>
      <Hint text={`Close find and go back to the latest (Esc). ${FIND_SHORTCUT} opens it again`}>
        <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={onClose}>
          <X />
        </Button>
      </Hint>
    </div>
  )
}

/** The header button that opens find, which phones need in place of Ctrl+F. */
export function FindButton({ onClick }: { onClick: () => void }) {
  return (
    <Hint text={`Find in this chat (${FIND_SHORTCUT})`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Find in this chat"
        data-testid="chat-find-open"
        className={WIDE_BUTTON}
        onClick={onClick}
      >
        <Search />
        <span className={WIDE_LABEL}>Find</span>
      </Button>
    </Hint>
  )
}

import { TextSearch } from 'lucide-react'
import { Hint } from '@/components/Hint'
import type { FindState } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'
import { keepFocus } from '@/lib/keep-focus'

/** Opens find and replace in a message box, for screens without a keyboard to press Ctrl+F. */
export function FindButton({ find }: { find: FindState }) {
  return (
    <Hint text="Find and replace in the message">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Find"
        className="shrink-0 pointer-coarse:size-10"
        onMouseDown={keepFocus}
        onClick={find.openFind}
      >
        <TextSearch />
      </Button>
    </Hint>
  )
}

/**
 * Opens find in a long text field on a touch screen. It sits in the field's top right corner
 * while the field has focus, inside a `group/find` box, so it never crowds a form at rest.
 */
export function FieldFindButton({ find }: { find: FindState }) {
  return (
    <Hint text="Find and replace in the text">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Find"
        className="absolute top-1 right-1 z-10 hidden size-9 bg-background/80 group-focus-within/find:inline-flex"
        onMouseDown={keepFocus}
        onClick={find.openFind}
      >
        <TextSearch />
      </Button>
    </Hint>
  )
}

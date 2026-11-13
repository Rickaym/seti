import { TextSearch } from 'lucide-react'
import { Hint } from '@/components/Hint'
import type { FindState } from '@/components/find/useFind'
import { Button } from '@/components/ui/button'

/** Opens find and replace in a message box, for screens without a keyboard to press Ctrl+F. */
export function FindButton({ find }: { find: FindState }) {
  return (
    <Hint text="Find and replace in the message">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Find"
        className="shrink-0 pointer-coarse:size-10"
        onClick={find.openFind}
      >
        <TextSearch />
      </Button>
    </Hint>
  )
}

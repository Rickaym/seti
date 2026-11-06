import { TERMINAL_NAME_MAX } from '@seti/shared'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface TerminalNameProps {
  name: string
  label: string
  /** Keeps the typed name; a blank one keeps the old name. */
  onCommit: (name: string) => void
  onDone: () => void
  className?: string
}

/** Edits a terminal's name in place: Enter or leaving keeps it, Escape cancels. */
export function TerminalName({ name: current, label, onCommit, onDone, className }: TerminalNameProps) {
  const [name, setName] = useState(current)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const commit = () => {
    onCommit(name)
    onDone()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      commit()
    } else if (event.key === 'Escape') {
      onDone()
    }
  }
  return (
    <Input
      aria-label={label}
      value={name}
      maxLength={TERMINAL_NAME_MAX}
      ref={input}
      onChange={(event) => {
        setName(event.target.value)
      }}
      onKeyDown={onKeyDown}
      onBlur={commit}
      className={cn('h-6 min-w-0 shrink px-1.5 py-0 text-xs', className)}
    />
  )
}

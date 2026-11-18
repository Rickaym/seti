import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'

interface StatusLineProps {
  /** What the agent said it is doing, such as waiting on CI; null shows nothing. */
  text: string | null
  className?: string
  /** Show the whole text on hover; off inside a control that carries it in its own title. */
  hint?: boolean
}

/** The live status an agent set on its row, muted and cut to fit. */
export function StatusLine({ text, className, hint = true }: StatusLineProps) {
  if (text === null) {
    return null
  }
  const line = (
    <span data-testid="status-line" className={cn('min-w-0 truncate text-xs text-muted-foreground', className)}>
      {text}
    </span>
  )
  return hint ? <Hint text={text}>{line}</Hint> : line
}

import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** The longer reason behind a short label, one tap away on a phone as on a desktop. */
export function InfoTip({
  label,
  text,
  className,
  children,
}: {
  /** The trigger's accessible name, such as "About Bypass"; needed when it shows only the icon. */
  label?: string
  text: ReactNode
  className?: string
  /** What to press; an info icon when left out. */
  children?: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          'relative inline-flex shrink-0 items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-3',
          className,
        )}
      >
        {children ?? <Info className="size-3.5" aria-hidden />}
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto max-w-72 gap-1.5 leading-relaxed">
        {text}
      </PopoverContent>
    </Popover>
  )
}

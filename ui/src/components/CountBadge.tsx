import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** A count on an icon button's top-right corner, kept inside the button so headers never clip it. */
export function CountBadge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      {...props}
      className={cn(
        'pointer-events-none absolute top-0 right-0 min-w-4 translate-x-1/4 rounded-full bg-primary px-1 text-2xs/4 font-semibold text-primary-foreground tabular-nums',
        className,
      )}
    />
  )
}

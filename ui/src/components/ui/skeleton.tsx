import * as React from 'react'
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('rounded-none bg-muted motion-safe:animate-pulse', className)}
      {...props}
    />
  )
}

export { Skeleton }

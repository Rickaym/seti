import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A 44px row and its rule heading a detail view: back, a marker, the name, then actions. */
export function DetailBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'agent-rule box-content flex h-11 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3 max-md:pl-2',
        className,
      )}
      {...props}
    />
  )
}

/** The bar's actions, kept together at its end. */
export function DetailBarActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>
}

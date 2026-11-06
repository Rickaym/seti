import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Section({
  title,
  count,
  defaultOpen = true,
  forceOpen = false,
  actions,
  className,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  forceOpen?: boolean
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const shown = open || forceOpen
  const Chevron = shown ? ChevronDown : ChevronRight
  return (
    <section className={cn('border border-border bg-card', className)}>
      <div className={cn('flex items-center gap-3 px-3 py-2', shown && 'border-b border-border')}>
        <button
          type="button"
          aria-expanded={shown}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold pointer-coarse:min-h-11"
          onClick={() => {
            setOpen(!shown)
          }}
        >
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          {title}
          <span className="text-xs font-normal text-muted-foreground">{count}</span>
        </button>
        {actions}
      </div>
      {shown && children}
    </section>
  )
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground">{children}</p>
}

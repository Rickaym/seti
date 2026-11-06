import { NEWS_DESCRIPTION } from '@/lib/mod-views'
import { cn } from '@/lib/utils'

/** A dot on a way into something the user has not seen yet; aria-describedby can name `id`. */
export function NewsDot({ id, className }: { id?: string; className?: string }) {
  return (
    <span data-news className={cn('size-1.5 shrink-0 rounded-full bg-primary', className)}>
      {id !== undefined && (
        <span id={id} hidden>
          {NEWS_DESCRIPTION}
        </span>
      )}
    </span>
  )
}

import type { ReactNode, Ref } from 'react'
import { DetailHeader } from '@/components/SplitPane'
import { cn } from '@/lib/utils'

/** A page's header strip: the title with its actions on the right and one muted line under it. */
export function PageHeader({
  title,
  description,
  actions,
  back,
  heading,
  level = 1,
}: {
  title: string
  description?: string | undefined
  actions?: ReactNode
  /** A control before the title, such as the back button of a page inside a section. */
  back?: ReactNode
  /** Takes the title's place, such as an input while renaming. */
  heading?: ReactNode
  level?: 1 | 2 | undefined
}) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <DetailHeader actions={actions}>
      <div className="flex min-w-0 items-center gap-2">
        {back}
        {heading ?? <Heading className="truncate text-lg font-semibold max-md:text-base">{title}</Heading>}
      </div>
      {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
    </DetailHeader>
  )
}

/** A page under a `PageHeader` that stays put while the body scrolls; `narrow` caps the body. */
export function PageLayout({
  header,
  narrow = false,
  scrollRef,
  children,
}: {
  header: ReactNode
  narrow?: boolean
  scrollRef?: Ref<HTMLDivElement> | undefined
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-6 max-md:p-3">
        <div className={cn(narrow && 'max-w-3xl')}>{children}</div>
      </div>
    </div>
  )
}

import { ArrowLeft } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { PaneSplitter } from '@/components/resize/ResizablePane'
import { usePaneResize } from '@/components/resize/usePaneResize'
import { Button } from '@/components/ui/button'
import type { PaneSpec } from '@/lib/pane-size'
import { PANEL } from '@/lib/panels'
import { goUp } from '@/lib/route'
import type { SectionKey } from '@/lib/sections'
import { cn } from '@/lib/utils'

/** The resizable list of a list and detail page; below md it fills the screen until one opens. */
export function ListPane({
  detailOpen,
  pane,
  label,
  className,
  children,
}: {
  detailOpen: boolean
  pane: PaneSpec
  /** Names the splitter, as in "Resize agent list". */
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { style, control } = usePaneResize(ref, pane, 'start')
  return (
    <div
      ref={ref}
      style={style}
      {...PANEL}
      className={cn(
        'relative flex w-(--pane-w) max-w-(--pane-max) shrink-0 flex-col border-r border-border max-md:w-full max-md:max-w-none max-md:border-r-0',
        className,
        detailOpen && 'max-md:hidden',
      )}
    >
      {children}
      <PaneSplitter label={label} side="start" control={control} />
    </div>
  )
}

/** The detail beside a `ListPane`; below md it shows alone, and only while the route opens one. */
export function DetailPane({ detailOpen, children }: { detailOpen: boolean; children: ReactNode }) {
  return (
    <div data-slot="detail-pane" {...PANEL} className={cn('min-w-0 flex-1', !detailOpen && 'max-md:hidden')}>
      {children}
    </div>
  )
}

/** Back to the section's list, below md where the list and the detail do not share the screen. */
export function BackButton({ section, label }: { section: SectionKey; label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-2 shrink-0 md:hidden"
      aria-label={`Back to ${label}`}
      onClick={() => {
        goUp(section)
      }}
    >
      <ArrowLeft />
    </Button>
  )
}

interface DetailHeaderProps {
  actions?: ReactNode
  /** Lines under both the title and the actions, so they use the header's full width. */
  below?: ReactNode
  children: ReactNode
}

/** A detail pane's header; on narrow screens its actions wrap under the title, not squeeze it. */
export function DetailHeader({ actions, below, children }: DetailHeaderProps) {
  return (
    <div className="agent-rule shrink-0 space-y-1 border-b border-border px-5 py-3 max-md:px-3 max-md:py-2">
      <div
        className={cn(
          'flex justify-between gap-4 max-md:gap-2 max-[48rem]:flex-wrap',
          below === undefined ? 'items-start' : 'items-center',
        )}
      >
        <div className="min-w-0 space-y-1 max-[48rem]:basis-full">{children}</div>
        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:gap-1">{actions}</div>
        )}
      </div>
      {below}
    </div>
  )
}

/** Wraps to two lines below 48rem unless `oneLine`, where a compact header truncates it instead. */
export function DetailTitle({ oneLine = false, children }: { oneLine?: boolean; children: ReactNode }) {
  return (
    <h2
      className={cn(
        'truncate text-lg font-semibold max-md:text-base in-data-agent-frame:text-sm',
        oneLine ? 'min-w-0 flex-1' : 'max-[48rem]:line-clamp-2 max-[48rem]:whitespace-normal max-[48rem]:wrap-anywhere',
      )}
    >
      {children}
    </h2>
  )
}

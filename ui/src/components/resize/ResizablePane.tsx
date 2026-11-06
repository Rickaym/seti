import { useRef, type ComponentProps, type ReactNode } from 'react'
import { Splitter, type SplitterControl } from '@/components/resize/Splitter'
import { usePaneResize } from '@/components/resize/usePaneResize'
import type { PaneSide, PaneSpec } from '@/lib/pane-size'
import { cn } from '@/lib/utils'

/** The splitter on a pane's inner edge, centred on its border; phones never show it. */
export function PaneSplitter({ label, side, control }: { label: string; side: PaneSide; control: SplitterControl }) {
  return (
    <Splitter
      label={label}
      orientation="vertical"
      control={control}
      className={cn('absolute inset-y-0 max-md:hidden', side === 'start' ? '-right-1' : '-left-1')}
    />
  )
}

/** A side pane of `spec` width with a splitter on its inner edge. */
export function ResizablePane({
  spec,
  side,
  label,
  className,
  children,
  ...rest
}: {
  spec: PaneSpec
  side: PaneSide
  /** Names the splitter, as in "Resize group chat". */
  label: string
  className?: string
  children: ReactNode
} & Omit<ComponentProps<'div'>, 'ref' | 'style' | 'className' | 'children'>) {
  const ref = useRef<HTMLDivElement>(null)
  const { style, control } = usePaneResize(ref, spec, side)
  return (
    <div
      ref={ref}
      style={style}
      className={cn('relative w-(--pane-w) max-w-(--pane-max) shrink-0', className)}
      {...rest}
    >
      {children}
      <PaneSplitter label={label} side={side} control={control} />
    </div>
  )
}

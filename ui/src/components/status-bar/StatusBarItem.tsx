import { useContext, type ComponentProps, type ReactNode } from 'react'
import { RowContext, TONE, type StatusTone } from '@/components/status-bar/tone'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** A hint whose bold first line says what the item's icon stands for, with details under it. */
export function ItemHint({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const row = useContext(RowContext) !== null
  return (
    <span className="grid gap-0.5">
      <span className={cn(!row && 'font-semibold')}>{title}</span>
      {children}
    </span>
  )
}

const ITEM =
  'flex h-full items-center gap-1.5 px-2 whitespace-nowrap outline-none pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-2'

const ROW =
  'grid w-full shrink-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3 border-b border-border px-4 py-2.5 text-left text-xs outline-none last:border-b-0'

interface ItemProps {
  label: string
  /** The item's name as a row heading in the health sheet. */
  name?: string
  tooltip: ReactNode
  tone?: StatusTone
  onClick?: (() => void) | undefined
  className?: string
  children: ReactNode
}

function ItemRow({
  label,
  name,
  tooltip,
  tone = 'default',
  onClick,
  children,
  onPick,
}: ItemProps & { onPick: () => void }) {
  const body = (
    <>
      <span className={cn('flex min-h-5 items-center gap-1.5', TONE[tone])}>{children}</span>
      <span className="grid min-w-0 gap-0.5">
        <span className="font-semibold">{name ?? label}</span>
        <span className="text-muted-foreground">{tooltip}</span>
      </span>
    </>
  )
  if (onClick === undefined) {
    return (
      <div role="status" aria-label={label} data-tone={tone} className={ROW}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      data-tone={tone}
      onClick={() => {
        onPick()
        onClick()
      }}
      className={cn(ROW, 'min-h-11 hover:bg-accent focus-visible:bg-accent')}
    >
      {body}
    </button>
  )
}

/** What a menu trigger wrapping the item hands its button, such as the menu's pointer handlers. */
type TriggerProps = Omit<ComponentProps<'button'>, keyof ItemProps | 'children'>

const triggerProps = ({
  label: _label,
  name: _name,
  tooltip: _tooltip,
  tone: _tone,
  onClick: _onClick,
  className: _className,
  children: _children,
  ...trigger
}: ItemProps & TriggerProps): TriggerProps => trigger

export function StatusBarItem(props: ItemProps & TriggerProps) {
  const row = useContext(RowContext)
  if (row !== null) {
    return <ItemRow {...props} onPick={row.onPick} />
  }
  const { label, tooltip, tone = 'default', onClick, className: extra, children } = props
  const trigger = triggerProps(props)
  const className = cn(ITEM, TONE[tone], extra)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick !== undefined || trigger.onPointerDown !== undefined ? (
          <button
            type="button"
            {...trigger}
            aria-label={label}
            data-tone={tone}
            onClick={onClick}
            className={cn(className, 'cursor-pointer hover:bg-foreground/10 focus-visible:bg-foreground/10')}
          >
            {children}
          </button>
        ) : (
          <div role="status" aria-label={label} data-tone={tone} className={className}>
            {children}
          </div>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

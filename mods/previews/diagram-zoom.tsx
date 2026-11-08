import { Maximize, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react'
import { useKit } from './kit'
import { ZOOM_MAX, ZOOM_MIN, type Zoom } from './use-zoom'

export function ToolButton({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
}) {
  const { Hint, Button } = useKit()
  return (
    <Hint text={label}>
      <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon />
      </Button>
    </Hint>
  )
}

/** The zoom level, Zoom out, Zoom in and Fit to width. */
export function ZoomTools({ zoom, drawn }: { zoom: Zoom; drawn: boolean }) {
  return (
    <>
      <span className="tabular-nums text-muted-foreground">
        {drawn ? `${String(Math.round(zoom.scale * 100))}%` : ''}
      </span>
      <ToolButton label="Zoom out" icon={ZoomOut} disabled={!drawn || zoom.scale <= ZOOM_MIN} onClick={zoom.zoomOut} />
      <ToolButton label="Zoom in" icon={ZoomIn} disabled={!drawn || zoom.scale >= ZOOM_MAX} onClick={zoom.zoomIn} />
      <ToolButton label="Fit to width" icon={Maximize} disabled={!drawn} onClick={zoom.fitWidth} />
    </>
  )
}

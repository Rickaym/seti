import type { ModFileViewProps, ModKit } from '@seti/mod-api'
import { Copy, FileDown, ImageDown, Maximize, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { pngOf, saveFile, standaloneSvg } from './diagram-export'
import type { DiagramError } from './diagram-render'
import { useKit } from './kit'
import { MONO, useRendered, type Drawn } from './use-rendered'

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.1
const ZOOM_MAX = 8
const FRAME_PADDING = 24

function ErrorPanel({ error, source }: { error: DiagramError; source: string }) {
  const { cn } = useKit()
  const lines = source.split('\n')
  return (
    <div role="alert" className="space-y-2 border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <p className="font-medium text-destructive">
        {error.line === null ? 'This diagram has an error' : `This diagram has an error on line ${String(error.line)}`}
      </p>
      <pre className={cn(MONO, 'break-words whitespace-pre-wrap text-foreground/85')}>{error.message}</pre>
      <ol className={cn(MONO, 'max-h-64 overflow-auto border border-border bg-code/60 py-1')}>
        {lines.map((line, index) => (
          <li
            key={index}
            className={cn('flex gap-3 px-2', index + 1 === error.line && 'bg-destructive/15 text-destructive')}
          >
            <span className="w-8 shrink-0 text-right text-muted-foreground select-none">{index + 1}</span>
            <span className="whitespace-pre">{line}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ToolButton({
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

const baseName = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name)

function exportActions(drawn: Drawn, name: string, background: string, { succeed, fail, errorText }: ModKit) {
  const svg = () => standaloneSvg(drawn.svg, drawn.width, drawn.height)
  return {
    copy: () => {
      navigator.clipboard.writeText(svg()).then(
        () => {
          succeed('SVG copied')
        },
        () => {
          fail('Copy failed')
        },
      )
    },
    svg: () => {
      saveFile(new Blob([svg()], { type: 'image/svg+xml' }), `${baseName(name)}.svg`)
    },
    png: () => {
      pngOf(svg(), drawn.width, drawn.height, background).then(
        (blob) => {
          saveFile(blob, `${baseName(name)}.png`)
        },
        (e: unknown) => {
          fail('Could not make the PNG', errorText(e))
        },
      )
    },
  }
}

/** Mouse drags scroll the frame; touch keeps its native scrolling. */
function usePan() {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) {
        return
      }
      const frame = e.currentTarget
      drag.current = { x: e.clientX, y: e.clientY, left: frame.scrollLeft, top: frame.scrollTop }
      frame.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const from = drag.current
      if (from !== null) {
        e.currentTarget.scrollTo(from.left - (e.clientX - from.x), from.top - (e.clientY - from.y))
      }
    },
    onPointerUp: () => {
      drag.current = null
    },
    onPointerCancel: () => {
      drag.current = null
    },
  }
}

function useFrameWidth() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (frame === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setWidth(frame.clientWidth)
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
  }, [frame])
  return { setFrame, width }
}

/** A diagram file: fitted to the width at first, with zoom, drag to pan, and SVG or PNG export. */
export function MermaidDiagram({ text, name, theme: viewTheme }: ModFileViewProps) {
  const kit = useKit()
  const source = text ?? ''
  const { drawn, error, theme } = useRendered(source, viewTheme, 0)
  const [zoom, setZoom] = useState<number | null>(null)
  const { setFrame, width: frameWidth } = useFrameWidth()
  const pan = usePan()
  const fit =
    drawn === null || drawn.width === 0
      ? 1
      : Math.min(1, Math.max(ZOOM_MIN, (frameWidth - FRAME_PADDING) / drawn.width))
  const scale = zoom ?? fit
  const actions = drawn === null ? null : exportActions(drawn, name, theme.background, kit)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {drawn === null ? '' : `${String(Math.round(scale * 100))}%`}
        </span>
        <ToolButton
          label="Zoom out"
          icon={ZoomOut}
          disabled={drawn === null || scale <= ZOOM_MIN}
          onClick={() => {
            setZoom(Math.max(ZOOM_MIN, scale / ZOOM_STEP))
          }}
        />
        <ToolButton
          label="Zoom in"
          icon={ZoomIn}
          disabled={drawn === null || scale >= ZOOM_MAX}
          onClick={() => {
            setZoom(Math.min(ZOOM_MAX, scale * ZOOM_STEP))
          }}
        />
        <ToolButton
          label="Fit to width"
          icon={Maximize}
          disabled={drawn === null}
          onClick={() => {
            setZoom(null)
          }}
        />
        <span className="ml-auto" />
        <ToolButton label="Copy SVG" icon={Copy} disabled={actions === null} onClick={() => actions?.copy()} />
        <ToolButton label="Download SVG" icon={FileDown} disabled={actions === null} onClick={() => actions?.svg()} />
        <ToolButton label="Download PNG" icon={ImageDown} disabled={actions === null} onClick={() => actions?.png()} />
      </div>
      <div
        ref={setFrame}
        className={kit.cn(
          'min-h-0 flex-1 overflow-auto bg-muted/40 p-3',
          drawn !== null && 'cursor-grab active:cursor-grabbing',
        )}
        {...pan}
      >
        {error !== null && <ErrorPanel error={error} source={source} />}
        {error === null && drawn === null && <p className="text-sm text-muted-foreground">Drawing the diagram...</p>}
        {drawn !== null && (
          <div
            role="img"
            aria-label={`Diagram of ${name}`}
            className="mx-auto [&>svg]:block [&>svg]:size-full [&>svg]:max-w-none!"
            style={{ width: drawn.width * scale, height: drawn.height * scale }}
            dangerouslySetInnerHTML={{ __html: drawn.svg }}
          />
        )}
      </div>
    </div>
  )
}

import type { ModFileViewProps, ModKit } from '@seti/mod-api'
import { Copy, FileDown, ImageDown } from 'lucide-react'
import { pngOf, saveFile, standaloneSvg } from './diagram-export'
import type { DiagramError } from './diagram-render'
import { ToolButton, ZoomTools } from './diagram-zoom'
import { useKit } from './kit'
import { MONO, useRendered, type Drawn } from './use-rendered'
import { useZoom } from './use-zoom'

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

/** A diagram file: fitted to the width at first, with zoom, drag to pan, and SVG or PNG export. */
export function MermaidDiagram({ text, name, theme: viewTheme }: ModFileViewProps) {
  const kit = useKit()
  const source = text ?? ''
  const { drawn, error, theme } = useRendered(source, viewTheme, 0)
  const zoom = useZoom(drawn)
  const actions = drawn === null ? null : exportActions(drawn, name, theme.background, kit)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
        <ZoomTools zoom={zoom} drawn={drawn !== null} />
        <span className="ml-auto" />
        <ToolButton label="Copy SVG" icon={Copy} disabled={actions === null} onClick={() => actions?.copy()} />
        <ToolButton label="Download SVG" icon={FileDown} disabled={actions === null} onClick={() => actions?.svg()} />
        <ToolButton label="Download PNG" icon={ImageDown} disabled={actions === null} onClick={() => actions?.png()} />
      </div>
      <div
        {...zoom.frame}
        className={kit.cn(
          'min-h-0 flex-1 overflow-auto bg-muted/40 p-3',
          drawn !== null && 'cursor-grab active:cursor-grabbing',
        )}
      >
        {error !== null && <ErrorPanel error={error} source={source} />}
        {error === null && drawn === null && <p className="text-sm text-muted-foreground">Drawing the diagram...</p>}
        {drawn !== null && (
          <div
            role="img"
            aria-label={`Diagram of ${name}`}
            className="mx-auto [&>svg]:block [&>svg]:size-full [&>svg]:max-w-none!"
            style={zoom.size ?? undefined}
            dangerouslySetInnerHTML={{ __html: drawn.svg }}
          />
        )}
      </div>
    </div>
  )
}

import type { ModFenceProps } from '@seti/mod-api'
import { Code } from 'lucide-react'
import { useState } from 'react'
import { ZoomTools } from './diagram-zoom'
import { useKit } from './kit'
import { MONO, useRendered } from './use-rendered'
import { useZoom } from './use-zoom'

/** Agents stream fenced diagrams a token at a time, so a fence waits for a pause before drawing. */
const INLINE_SETTLE_MS = 250

/** A mermaid fence in Markdown: the diagram fitted to the text, zoomable, with its source. */
export function MermaidBlock({ source, theme }: ModFenceProps) {
  const { ToggleButton, cn } = useKit()
  const { drawn, error } = useRendered(source, theme, INLINE_SETTLE_MS)
  const [showSource, setShowSource] = useState(false)
  const zoom = useZoom(drawn)
  const code = (
    <pre className={cn(MONO, 'overflow-x-auto border border-border bg-code/60 px-3 py-2 text-xs')}>{source}</pre>
  )
  return (
    <figure className="space-y-1" aria-label="Mermaid diagram">
      {drawn !== null && (
        <div className="flex items-center gap-1 text-xs">
          {!showSource && <ZoomTools zoom={zoom} drawn />}
          <span className="ml-auto" />
          <ToggleButton
            pressed={showSource}
            onPressedChange={setShowSource}
            icon={<Code />}
            label="Source"
            hint="Show the diagram's source"
            iconOnly
          />
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error.line === null ? 'Diagram error: ' : `Diagram error on line ${String(error.line)}: `}
          {error.message.split('\n')[0]}
        </p>
      )}
      {drawn === null || showSource ? (
        code
      ) : (
        <div
          {...zoom.frame}
          data-testid="diagram-frame"
          className="max-h-[70vh] cursor-grab overflow-auto border border-border p-3 active:cursor-grabbing"
        >
          <div
            role="img"
            aria-label="Diagram"
            className="mx-auto [&>svg]:block [&>svg]:size-full [&>svg]:max-w-none!"
            style={zoom.size ?? undefined}
            dangerouslySetInnerHTML={{ __html: drawn.svg }}
          />
        </div>
      )}
    </figure>
  )
}

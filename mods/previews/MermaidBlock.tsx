import type { ModFenceProps } from '@seti/mod-api'
import { Code } from 'lucide-react'
import { useState } from 'react'
import { useKit } from './kit'
import { MONO, useRendered } from './use-rendered'

/** Agents stream fenced diagrams a token at a time, so a fence waits for a pause before drawing. */
const INLINE_SETTLE_MS = 250

/** A mermaid fence in Markdown: the diagram fitted to the text, its source a toggle away. */
export function MermaidBlock({ source, theme }: ModFenceProps) {
  const { ToggleButton, cn } = useKit()
  const { drawn, error } = useRendered(source, theme, INLINE_SETTLE_MS)
  const [showSource, setShowSource] = useState(false)
  const code = (
    <pre className={cn(MONO, 'overflow-x-auto border border-border bg-code/60 px-3 py-2 text-xs')}>{source}</pre>
  )
  return (
    <figure className="space-y-1" aria-label="Mermaid diagram">
      {drawn !== null && (
        <div className="flex justify-end">
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
          role="img"
          aria-label="Diagram"
          className="mx-auto w-full [&>svg]:block [&>svg]:size-full [&>svg]:max-w-none!"
          style={{ maxWidth: drawn.width, aspectRatio: `${String(drawn.width)} / ${String(drawn.height)}` }}
          dangerouslySetInnerHTML={{ __html: drawn.svg }}
        />
      )}
    </figure>
  )
}

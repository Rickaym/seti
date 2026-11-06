import type { ModViewTheme } from '@seti/mod-api'
import { useEffect, useState } from 'react'
import { renderMermaid, type DiagramError, type DiagramTheme, type Rendered } from './diagram-render'
import { useDiagramTheme } from './diagram-theme'

export const MONO = 'font-mono [font-variant-ligatures:none]'

export type Drawn = Extract<Rendered, { svg: string }>

/** The diagram drawn in Seti's theme, waiting `settleMs` after the source last changed. */
export function useRendered(
  source: string,
  viewTheme: ModViewTheme,
  settleMs: number,
): { drawn: Drawn | null; error: DiagramError | null; theme: DiagramTheme } {
  const theme = useDiagramTheme(viewTheme)
  const [result, setResult] = useState<Rendered | null>(null)
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void renderMermaid(source, theme).then((next) => {
        if (!live) {
          return
        }
        setResult(next)
        if ('svg' in next) {
          setDrawn(next)
        }
      })
    }, settleMs)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [source, theme, settleMs])
  const error = result !== null && 'error' in result ? result.error : null
  return { drawn: error === null ? drawn : null, error, theme }
}

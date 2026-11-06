import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useTheme } from '@/components/theme/theme-context'
import { useCoarsePointer, usePrefersReducedMotion } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { GraphCanvas } from './graph-canvas'
import { readGraphInk } from './graph-ink'
import type { GraphModel, GraphNodeSpec } from './graph-model'
import type { SimNode } from './graph-sim'

/** Space between a hovered node and its card, and between the card and the graph's edge. */
const CARD_GAP = 12
const EDGE_GAP = 8

interface Shown {
  id: string
  /** Picked by a tap or click, so it stays until dismissed; hover cards follow the pointer. */
  pinned: boolean
}

/** Puts a floating card beside its node, inside the graph's box. */
function placeCard(card: HTMLElement, at: { x: number; y: number; r: number }, box: DOMRect): void {
  const left = Math.min(Math.max(EDGE_GAP, at.x + at.r + CARD_GAP), box.width - card.offsetWidth - EDGE_GAP)
  const top = Math.min(Math.max(EDGE_GAP, at.y - card.offsetHeight / 2), box.height - card.offsetHeight - EDGE_GAP)
  card.style.setProperty('transform', `translate(${String(Math.round(left))}px, ${String(Math.round(top))}px)`)
}

const opensAgent = (node: SimNode) => node.kind === 'agent' || node.kind === 'subagent' || node.kind === 'tool'

/** The force graph on a canvas, with a card for the node under the pointer or last tapped. */
export function GraphView({
  model,
  label,
  highlight,
  fitSignal,
  onOpen,
  renderCard,
  className,
}: {
  model: GraphModel
  /** What the graph shows, for screen readers; the agent list beside it is the way to act. */
  label: string
  /** A node to bring forward, such as the agent hovered in the list beside the graph. */
  highlight: string | null
  /** Changes when the user asks to frame every node. */
  fitSignal: number
  onOpen: (node: GraphNodeSpec) => void
  renderCard: (node: GraphNodeSpec, pinned: boolean, close: () => void) => ReactNode
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<GraphCanvas | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const reduced = usePrefersReducedMotion()
  const coarse = useCoarsePointer()
  const { scheme, themeId, flavour, accent } = useTheme()
  const node = shown === null ? undefined : model.nodes.find((candidate) => candidate.id === shown.id)
  const pinned = node !== undefined && shown?.pinned === true
  const docked = pinned && coarse

  const hovered = useEffectEvent((at: SimNode | null) => {
    if (shown?.pinned !== true) {
      setShown(at === null ? null : { id: at.id, pinned: false })
    }
  })
  const tapped = useEffectEvent((at: SimNode | null, touch: boolean) => {
    if (at !== null && opensAgent(at) && (!touch || shown?.id === at.id)) {
      onOpen(at)
      return
    }
    setShown(at === null ? null : { id: at.id, pinned: true })
  })
  const follow = useEffectEvent(() => {
    const card = cardRef.current
    const at = shown === null ? null : graphRef.current?.screenOf(shown.id)
    if (card === null || at === null || at === undefined || docked) {
      return
    }
    placeCard(card, at, card.parentElement?.getBoundingClientRect() ?? new DOMRect())
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return undefined
    }
    const graph = new GraphCanvas(canvas, { onHover: hovered, onTap: tapped, onFrame: follow }, true)
    graphRef.current = graph
    return () => {
      graph.destroy()
      graphRef.current = null
    }
  }, [])

  useEffect(() => {
    graphRef.current?.setMotion(!reduced)
  }, [reduced])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      graphRef.current?.setInk(readGraphInk())
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [scheme, themeId, flavour, accent])

  useEffect(() => {
    graphRef.current?.setModel(model)
  }, [model])

  const focus = node?.id ?? highlight
  useEffect(() => {
    graphRef.current?.setFocus(focus)
  }, [focus])

  useEffect(() => {
    if (fitSignal > 0) {
      graphRef.current?.fit()
    }
  }, [fitSignal])

  useEffect(() => {
    if (!pinned) {
      return undefined
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setShown(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  return (
    <div className={cn('relative min-h-0 overflow-hidden', className)}>
      <canvas
        ref={canvasRef}
        aria-hidden
        data-testid="home-graph"
        className="absolute inset-0 size-full cursor-grab touch-none select-none"
      />
      <p className="sr-only">{label}</p>
      {node !== undefined && (
        <div
          key={docked ? 'docked' : 'floating'}
          ref={cardRef}
          data-testid="home-card"
          className={cn(
            'absolute z-10',
            docked ? 'inset-x-2 bottom-2' : 'top-0 left-0 w-64 max-w-[calc(100%-1rem)]',
            !pinned && 'pointer-events-none',
          )}
        >
          {renderCard(node, pinned, () => {
            setShown(null)
          })}
        </div>
      )}
    </div>
  )
}

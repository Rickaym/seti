import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { usePrefersReducedMotion } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'

/** Scroll speed in pixels per second, so a longer text takes longer to reveal. */
const SPEED = 50
const PAUSE_MS = 500
const RETURN_MS = 200

/** `rest` shows the ellipsis; `out` scrolls to the end; `back` returns to the start. */
type Phase = 'rest' | 'out' | 'back'

/** The row whose hover or focus scrolls the text: the nearest link, button or list item. */
const ROW = 'a, button, li'

interface Props {
  text: string
  className?: string
  /** The native tooltip while the text is cut short; `null` leaves it to an ancestor's title. */
  title?: string | null
}

/** One line with an ellipsis that scrolls to its end while its row is hovered or focused. */
export function ScrollOnHover({ text, className, title = text }: Props) {
  const outer = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [hidden, setHidden] = useState(0)
  const [phase, setPhase] = useState<Phase>('rest')
  const reduced = usePrefersReducedMotion()
  const moves = hidden > 0 && !reduced

  useLayoutEffect(() => {
    const box = outer.current
    const line = inner.current
    if (box === null || line === null) {
      return
    }
    const measure = () => {
      setHidden(Math.max(0, line.scrollWidth - box.clientWidth))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => {
      observer.disconnect()
    }
  }, [text])

  useEffect(() => {
    const box = outer.current
    if (box === null || !moves) {
      return
    }
    const row = box.parentElement?.closest<HTMLElement>(ROW) ?? box
    const start = () => {
      setPhase('out')
    }
    const stop = () => {
      setPhase((now) => (now === 'rest' ? now : 'back'))
    }
    const enter = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') {
        start()
      }
    }
    const focus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(':focus-visible')) {
        start()
      }
    }
    const blur = () => {
      if (!row.matches(':hover')) {
        stop()
      }
    }
    row.addEventListener('pointerenter', enter)
    row.addEventListener('pointerleave', stop)
    row.addEventListener('focusin', focus)
    row.addEventListener('focusout', blur)
    return () => {
      row.removeEventListener('pointerenter', enter)
      row.removeEventListener('pointerleave', stop)
      row.removeEventListener('focusin', focus)
      row.removeEventListener('focusout', blur)
    }
  }, [moves])

  useEffect(() => {
    if (phase !== 'back') {
      return
    }
    const timer = setTimeout(() => {
      setPhase((now) => (now === 'back' ? 'rest' : now))
    }, RETURN_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [phase])

  const shown = moves ? phase : 'rest'
  const styles: Record<Phase, CSSProperties | undefined> = {
    rest: undefined,
    out: {
      transform: `translateX(-${String(hidden)}px)`,
      transition: `transform ${(hidden / SPEED).toFixed(2)}s linear ${String(PAUSE_MS)}ms`,
    },
    back: { transform: 'translateX(0)', transition: `transform ${String(RETURN_MS)}ms ease-out` },
  }

  return (
    <span
      ref={outer}
      data-slot="scroll-on-hover"
      data-overflow={hidden > 0 ? '' : undefined}
      className={cn('block min-w-0 overflow-hidden', className)}
      title={hidden > 0 && title !== null ? title : undefined}
    >
      <span
        ref={inner}
        className={cn('block whitespace-nowrap', shown === 'rest' ? 'truncate' : 'overflow-visible')}
        style={styles[shown]}
      >
        {text}
      </span>
    </span>
  )
}

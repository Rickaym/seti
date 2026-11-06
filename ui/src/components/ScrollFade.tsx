import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

interface Edges {
  start: boolean
  end: boolean
}

/** A sideways scroller that fades each edge with more content past it, so touch users see it. */
export function ScrollFade({ className, children, ...props }: ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edges>({ start: false, end: false })

  useEffect(() => {
    const el = ref.current
    if (el === null) {
      return
    }
    const update = () => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    for (const child of Array.from(el.children)) {
      observer.observe(child)
    }
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={ref}
      data-slot="scroll-fade"
      data-fade-start={edges.start ? '' : undefined}
      data-fade-end={edges.end ? '' : undefined}
      className={cn('overflow-x-auto overscroll-x-contain', className)}
      {...props}
    >
      {children}
    </div>
  )
}

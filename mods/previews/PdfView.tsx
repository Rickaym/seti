import type { ModFileViewProps, ModKit } from '@seti/mod-api'
import { ChevronLeft, ChevronRight, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'

GlobalWorkerOptions.workerSrc = workerUrl

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (element === null) {
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry?.contentRect.width ?? 0))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [element])
  return width
}

function usePdf(url: string, errorText: ModKit['errorText']): { doc: PDFDocumentProxy | null; error: string | null } {
  const [state, setState] = useState<{ url: string; doc: PDFDocumentProxy | null; error: string | null }>({
    url,
    doc: null,
    error: null,
  })
  useEffect(() => {
    const loading = getDocument({ url, useWasm: false })
    loading.promise.then(
      (doc) => {
        setState({ url, doc, error: null })
      },
      (e: unknown) => {
        setState({ url, doc: null, error: errorText(e) })
      },
    )
    return () => {
      void loading.destroy()
    }
  }, [url, errorText])
  return state.url === url ? state : { doc: null, error: null }
}

/** One page at a time, fitted to the width and zoomable, drawn sharp on high density screens. */
export const pdfView = ({ Button, Hint, errorText }: ModKit) =>
  function PdfView({ url, name }: ModFileViewProps) {
    const { doc, error } = usePdf(url, errorText)
    const [page, setPage] = useState(1)
    const [zoom, setZoom] = useState(1)
    const [frame, setFrame] = useState<HTMLDivElement | null>(null)
    const canvas = useRef<HTMLCanvasElement>(null)
    const width = useWidth(frame)
    const pages = doc?.numPages ?? 0
    const shown = Math.min(page, Math.max(pages, 1))

    useEffect(() => {
      const target = canvas.current
      if (doc === null || target === null || width === 0) {
        return undefined
      }
      let task: RenderTask | null = null
      let cancelled = false
      void doc.getPage(shown).then((pdfPage) => {
        if (cancelled) {
          return
        }
        const base = pdfPage.getViewport({ scale: 1 })
        const viewport = pdfPage.getViewport({ scale: (width / base.width) * zoom })
        const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
        target.width = Math.floor(viewport.width * ratio)
        target.height = Math.floor(viewport.height * ratio)
        target.style.width = `${String(Math.floor(viewport.width))}px`
        target.style.height = `${String(Math.floor(viewport.height))}px`
        task = pdfPage.render({
          canvas: target,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        task.promise.catch(() => undefined)
      })
      return () => {
        cancelled = true
        task?.cancel()
      }
    }, [doc, shown, width, zoom])

    if (error !== null) {
      return (
        <p className="p-4 text-sm text-destructive">
          Could not open {name}: {error}
        </p>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
          <Hint text="Previous page">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous page"
              disabled={shown <= 1}
              onClick={() => {
                setPage(shown - 1)
              }}
            >
              <ChevronLeft />
            </Button>
          </Hint>
          <span className="tabular-nums" aria-live="polite">
            {pages === 0 ? 'Loading...' : `Page ${String(shown)} of ${String(pages)}`}
          </span>
          <Hint text="Next page">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next page"
              disabled={shown >= pages}
              onClick={() => {
                setPage(shown + 1)
              }}
            >
              <ChevronRight />
            </Button>
          </Hint>
          <span className="ml-auto tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Hint text="Zoom out">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => {
                setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))
              }}
            >
              <ZoomOut />
            </Button>
          </Hint>
          <Hint text="Zoom in">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => {
                setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))
              }}
            >
              <ZoomIn />
            </Button>
          </Hint>
          <Hint text="Fit to width">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Fit to width"
              onClick={() => {
                setZoom(1)
              }}
            >
              <Maximize />
            </Button>
          </Hint>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3">
          <div ref={setFrame} className="w-full">
            <canvas ref={canvas} className="mx-auto block shadow-sm" aria-label={`${name}, page ${String(shown)}`} />
          </div>
        </div>
      </div>
    )
  }

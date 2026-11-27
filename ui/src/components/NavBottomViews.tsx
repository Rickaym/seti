import { useEffect, useState } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { navBottomViews, setNavPanel, useNavPanel, usePlacedViews } from '@/lib/mod-views'
import { cn } from '@/lib/utils'

/**
 * The views enabled mods add under the sidebar's sections. In the drawer they share the height
 * left under the sections and keep a minimum, so the sections scroll before the views vanish.
 */
export function NavBottomViews({ layout }: { layout: 'rail' | 'drawer' }) {
  const views = usePlacedViews(navBottomViews)
  const open = useNavPanel()
  if (views.length === 0) {
    return null
  }
  return (
    <div
      data-slot="nav-bottom"
      className={cn(
        'flex flex-col border-t border-border',
        layout === 'rail' ? 'shrink-0 items-center gap-1 py-2' : 'min-h-40 flex-1 basis-0',
      )}
    >
      {views.map(({ key, name, view: View }) => (
        <ErrorBoundary key={key} name={name} kind="item">
          <View
            layout={layout}
            panel={
              layout === 'rail'
                ? {
                    open: open === key,
                    toggle: () => {
                      setNavPanel(open === key ? null : key)
                    },
                  }
                : null
            }
          />
        </ErrorBoundary>
      ))}
    </div>
  )
}

/** Closes the open panel when Esc is pressed inside it and nothing else took the key. */
function useEscCloses(panel: HTMLElement | null): void {
  useEffect(() => {
    if (panel === null) {
      return undefined
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        setNavPanel(null)
      }
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
    }
  }, [panel])
}

/** The open panel of a `navBottom` view, beside the rail at its full height; Esc closes it. */
export function NavBottomPanel() {
  const views = usePlacedViews(navBottomViews)
  const open = useNavPanel()
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  useEscCloses(panel)
  const shown = views.find((view) => view.key === open)
  if (shown === undefined) {
    return null
  }
  const { key, name, view: View } = shown
  return (
    <section
      ref={setPanel}
      aria-label={name}
      data-slot="nav-panel"
      className="flex min-h-0 w-72 shrink-0 flex-col border-r border-border bg-card"
    >
      <ErrorBoundary key={key} name={name} kind="item">
        <View layout="panel" panel={null} />
      </ErrorBoundary>
    </section>
  )
}

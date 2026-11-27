import { ErrorBoundary } from '@/components/ErrorBoundary'
import { navBottomViews, usePlacedViews } from '@/lib/mod-views'
import { cn } from '@/lib/utils'

/**
 * The views enabled mods add under the sidebar's sections. In the drawer they share the height
 * left under the sections and keep a minimum, so the sections scroll before the views vanish.
 */
export function NavBottomViews({ layout }: { layout: 'rail' | 'drawer' }) {
  const views = usePlacedViews(navBottomViews)
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
          <View layout={layout} />
        </ErrorBoundary>
      ))}
    </div>
  )
}

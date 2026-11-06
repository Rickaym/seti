import { ErrorBoundary } from '@/components/ErrorBoundary'
import { headerViews, usePlacedViews } from '@/lib/mod-views'

/** The bands enabled mods add across the app header, or the gap they would fill. */
export function HeaderViews() {
  const views = usePlacedViews(headerViews)
  return (
    <>
      {views.length === 0 && <div aria-hidden data-slot="header-gap" className="min-w-0 flex-1 self-stretch" />}
      {views.map(({ key, name, view: View }) => (
        <ErrorBoundary key={key} name={name} kind="item">
          <View />
        </ErrorBoundary>
      ))}
    </>
  )
}

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { aboutParts, usePlacedViews } from '@/lib/mod-views'
import { SettingsBody, SettingsHeader } from './layout'
import { useMovedCard } from './use-moved-card'

/** The Seti you run, as the parts enabled mods add here tell it. */
export function AboutPage() {
  useMovedCard(true)
  const parts = usePlacedViews(aboutParts)
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader title="About" description="The Seti you run, whether a newer one waits, and what changed." />
      }
    >
      {parts.map(({ key, name, view: View }) => (
        <ErrorBoundary key={key} name={name} kind="row">
          <View />
        </ErrorBoundary>
      ))}
    </SettingsBody>
  )
}

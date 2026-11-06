import { useSyncExternalStore } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { inputHooks } from '@/lib/input-hooks'

/** What input hooks draw above the page, such as Vim mode's list of keys. */
export function InputHookOverlays() {
  const hooks = useSyncExternalStore(inputHooks.subscribe, inputHooks.list)
  return hooks.map(({ key, overlay: Overlay }) =>
    Overlay === undefined ? null : (
      <ErrorBoundary key={key} name={key}>
        <Overlay />
      </ErrorBoundary>
    ),
  )
}

import { useSyncExternalStore } from 'react'
import { ToggleButton } from '@/components/ToggleButton'
import { setLayoutActive, useLayouts, type AgentsLayout } from '@/panels/tasks/agents-layouts'

function LayoutToggle({ layout }: { layout: AgentsLayout }) {
  const on = useSyncExternalStore(layout.active.subscribe, layout.active.get)
  const Icon = layout.icon
  return (
    <ToggleButton
      pressed={on}
      onPressedChange={(next) => {
        setLayoutActive(layout, next)
      }}
      icon={<Icon />}
      label={layout.title}
      iconOnly
      hint={layout.hint(on)}
    />
  )
}

/** The Agents list's switch between one agent and each layout this screen can show. */
export function LayoutToggles({ narrow }: { narrow: boolean }) {
  return useLayouts(narrow).map((layout) => <LayoutToggle key={layout.key} layout={layout} />)
}

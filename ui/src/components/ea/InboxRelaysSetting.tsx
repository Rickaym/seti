import { Forward } from 'lucide-react'
import { ToggleButton } from '@/components/ToggleButton'
import type { EaSettingsState } from './useEaSettings'

/** The user's switch for inbox relays; off until the user turns it on. */
export function InboxRelaysSetting({ state }: { state: EaSettingsState }) {
  const { settings, error, setRelays } = state
  if (settings === null) {
    return <span className="text-muted-foreground">{error ?? 'Loading'}</span>
  }
  return (
    <div className="flex flex-col items-end gap-1 max-md:items-stretch">
      <ToggleButton
        pressed={settings.inbox_relays}
        onPressedChange={(on) => {
          void setRelays(on)
        }}
        icon={Forward}
        label="Relays"
        hint="The EA may pass an inbox item to the agent it is about, in its own words, and tells you"
      />
      {error !== null && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}

import type { EaAssignSkip } from '@seti/shared'
import { UserRoundCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import type { EaSettingsState } from './useEaSettings'

/** The agents and channels the user told the EA to stop assigning to or from, each removable. */
function AssignSkips() {
  const [skips, setSkips] = useState<EaAssignSkip[]>([])
  useEffect(() => {
    apiGet<EaAssignSkip[]>('/ea/assign-skips').then(setSkips, (e: unknown) => toast.error(errorText(e)))
  }, [])
  const remove = async (skip: EaAssignSkip) => {
    try {
      setSkips(await apiPost<EaAssignSkip[]>('/ea/assign-skips/remove', { kind: skip.kind, ref: skip.ref }))
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <ul className="flex flex-wrap justify-end gap-1 max-md:justify-start" aria-label="Not assigned">
      {skips.map((skip) => {
        const label = `${skip.kind === 'agent' ? 'Not to' : 'Not from'} ${skip.name}`
        return (
          <li key={`${skip.kind}:${skip.ref}`} data-testid="ea-assign-skip">
            <Hint text="The EA asks you about these again once removed">
              <Button
                variant="outline"
                size="xs"
                onClick={() => void remove(skip)}
                aria-label={`Remove: ${label}`}
                className="pointer-coarse:h-11"
              >
                {label}
                <X aria-hidden="true" />
              </Button>
            </Hint>
          </li>
        )
      })}
    </ul>
  )
}

/** The user's switch for Assign; off until the user turns it on. */
export function AssignSetting({ state }: { state: EaSettingsState }) {
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
        icon={UserRoundCheck}
        label="Assign"
        hint="The EA hands work it judges safe to the right agent without asking, and tells you in a line"
      />
      <AssignSkips />
      {error !== null && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}

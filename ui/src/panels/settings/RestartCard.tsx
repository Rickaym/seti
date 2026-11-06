import type { AutoArchiveStatus } from '@seti/shared'
import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { SettingRow, SettingsCard } from './layout'

/** Whether agents a Seti restart cut off go on by themselves once Seti is back. */
export function RestartCard() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<AutoArchiveStatus>('/archive/settings')
      .then((status) => {
        setOn(status.settings.resume_after_restart)
      })
      .catch((e: unknown) => {
        toast.error(errorText(e))
      })
  }, [])

  const change = async (next: boolean) => {
    setBusy(true)
    try {
      const status = await apiPut<AutoArchiveStatus>('/archive/settings', { resume_after_restart: next })
      setOn(status.settings.resume_after_restart)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard title="Restarts">
      <SettingRow label="Resume after restart">
        <ToggleButton
          pressed={on === true}
          disabled={on === null || busy}
          onPressedChange={(next) => void change(next)}
          icon={RotateCcw}
          label="Resume"
          hint={
            on === false
              ? 'Agents a restart cut off wait for you to retry or reply'
              : 'Agents a restart cut off get one message to check their work and go on, unless they were waiting on you'
          }
        />
      </SettingRow>
    </SettingsCard>
  )
}

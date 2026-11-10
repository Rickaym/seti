import type { AutoArchiveStatus } from '@seti/shared'
import { Repeat, RotateCcw, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { SettingRow, SettingsCard } from './layout'

/** An on/off lifecycle setting stored with the archive settings. */
type Flag = 'resume_after_restart' | 'repeat_guard'

interface FlagCopy {
  title: string
  row: string
  label: string
  icon: LucideIcon
  on: string
  off: string
}

function FlagCard({ flag, copy }: { flag: Flag; copy: FlagCopy }) {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<AutoArchiveStatus>('/archive/settings')
      .then((status) => {
        setOn(status.settings[flag])
      })
      .catch((e: unknown) => {
        toast.error(errorText(e))
      })
  }, [flag])

  const change = async (next: boolean) => {
    setBusy(true)
    try {
      const status = await apiPut<AutoArchiveStatus>('/archive/settings', { [flag]: next })
      setOn(status.settings[flag])
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard title={copy.title}>
      <SettingRow label={copy.row}>
        <ToggleButton
          pressed={on === true}
          disabled={on === null || busy}
          onPressedChange={(next) => void change(next)}
          icon={copy.icon}
          label={copy.label}
          hint={on === false ? copy.off : copy.on}
        />
      </SettingRow>
    </SettingsCard>
  )
}

const RESTART: FlagCopy = {
  title: 'Restarts',
  row: 'Resume after restart',
  label: 'Resume',
  icon: RotateCcw,
  on: 'Agents a restart cut off get one message to check their work and go on, unless they were waiting on you',
  off: 'Agents a restart cut off wait for you to retry or reply',
}

const REPEATS: FlagCopy = {
  title: 'Repeats',
  row: 'Repeated calls',
  label: 'Ask first',
  icon: Repeat,
  on: 'An agent that runs the same call again after 2 identical results waits for you to allow it, in Bypass too',
  off: 'Agents may repeat a call that keeps giving the same result without asking',
}

/** Whether agents a Seti restart cut off go on by themselves once Seti is back. */
export const RestartCard = () => <FlagCard flag="resume_after_restart" copy={RESTART} />

/** Whether an agent that repeats a call with the same result waits for the user first. */
export const RepeatGuardCard = () => <FlagCard flag="repeat_guard" copy={REPEATS} />

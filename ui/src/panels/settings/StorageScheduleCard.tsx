import { SCHEDULE_IDLE_DAYS, type StorageSchedule, type StorageScheduleInput } from '@seti/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { refreshStorage } from '@/hooks/useStorage'
import { relativeTime } from '@/lib/time'
import { bytesLabel } from '@/panels/resources/format'
import { SettingRow, SettingsCard } from './layout'

function lastRun(schedule: StorageSchedule): string {
  if (schedule.last_run_at === null) {
    return 'It has not run yet.'
  }
  return `It last ran ${relativeTime(schedule.last_run_at)} and freed ${bytesLabel(schedule.last_freed_bytes ?? 0)}.`
}

/** The automatic clean: off by default; when on, an hourly sweep cleans agents idle long enough. */
export function StorageScheduleCard({ schedule }: { schedule: StorageSchedule }) {
  const [busy, setBusy] = useState(false)

  const save = async (change: StorageScheduleInput) => {
    setBusy(true)
    try {
      await apiPut<StorageSchedule>('/storage/schedule', change)
      refreshStorage()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard title="Automatic clean">
      <SettingRow
        label="Clean idle agents"
        stack
        description={`Removes rebuildable folders of agents idle longer than this, archived ones included. It never touches a running agent. ${lastRun(schedule)}`}
      >
        <div className="flex items-center gap-3">
          <Switch
            aria-label="Automatic clean"
            checked={schedule.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => void save({ enabled })}
          />
          <NativeSelect
            size="sm"
            aria-label="Idle days"
            value={String(schedule.idle_days)}
            disabled={busy}
            onChange={(event) => void save({ idle_days: Number(event.target.value) })}
          >
            {SCHEDULE_IDLE_DAYS.map((days) => (
              <NativeSelectOption key={days} value={String(days)}>
                {days} days
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </SettingRow>
    </SettingsCard>
  )
}

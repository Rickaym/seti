import type { ChannelInfo, ReminderChannelInfo, ReminderStatus, ReminderUpdateInput } from '@seti/shared'
import { Pencil, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { describeSchedule, formatWhen } from '@/components/schedule/cron'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Switch } from '@/components/ui/switch'
import { DESTRUCTIVE_ON_INTENT } from '@/components/ui/table-action-buttons'
import { durationLabel, relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { SettingRow, SettingsCard } from '../layout'
import { Activity } from './Activity'
import { ScheduleHealth } from './ScheduleHealth'
import { Subscribers } from './Subscribers'
import { intervalLabel } from './interval'
import { STALE } from './schedule-health'

const STATUS: Record<ReminderStatus, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'text-muted-foreground' },
  ok: { label: 'OK', tone: 'text-success' },
  erroring: { label: 'Erroring', tone: 'text-warning-text' },
  failing: { label: 'Failing', tone: 'text-destructive' },
  paused: { label: 'Paused', tone: 'text-muted-foreground' },
}

const nextRun = (iso: string) => {
  const ms = Date.parse(iso) - Date.now()
  return ms > 30_000 ? `in ${durationLabel(ms)}` : 'due now'
}

/** When it runs, in words, and the next run in local time. */
function timingText({ reminder }: ReminderChannelInfo): string {
  const { schedule } = reminder
  const when =
    schedule === null
      ? `Every ${intervalLabel(reminder.interval_s)}`
      : `${describeSchedule(schedule.cron)} (${schedule.timezone})`
  return reminder.next_run_at === null ? when : `${when}; next ${formatWhen(reminder.next_run_at)}`
}

function statusText(info: ReminderChannelInfo): string {
  const { reminder } = info
  const last = reminder.last_run_at === null ? 'No run yet' : `Last run ${relativeTime(reminder.last_run_at)}`
  const next = reminder.next_run_at === null ? '' : `; next ${nextRun(reminder.next_run_at)}`
  const failures = reminder.failures > 0 ? `; ${String(reminder.failures)} failed in a row` : ''
  return `${last}${next}${failures}`
}

/** A reminder: its status and schedule, subscribers, and its runs and messages folded away. */
export function ReminderCard({
  info,
  onChange,
  onRemoved,
  onEdit,
}: {
  info: ReminderChannelInfo
  onChange: (next: ChannelInfo) => void
  onRemoved: (id: string) => void
  onEdit: () => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const { reminder } = info
  const status = reminder.health.stale && reminder.status !== 'failing' ? STALE : STATUS[reminder.status]

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const update = (input: ReminderUpdateInput) => {
    void run(async () => {
      onChange(await apiPut<ReminderChannelInfo>(`/channels/reminders/${info.id}`, input))
    })
  }
  const runNow = () => {
    void run(async () => {
      const next = await apiPost<ReminderChannelInfo>(`/channels/reminders/${info.id}/run`, {})
      onChange(next)
      const last = next.reminder.runs[0]
      if (last?.outcome === 'error' || last?.outcome === 'timeout') {
        toast.error(`Run failed: ${last.error ?? 'unknown error'}`, { duration: Infinity, closeButton: true })
      } else {
        toast.success(last?.outcome === 'ok' ? 'Delivered' : 'Nothing to deliver')
      }
    })
  }
  const remove = async () => {
    const message = `Delete ${info.name}? Seti stops running it, and its messages and runs go with it.`
    if (await confirm({ message, confirmLabel: 'Delete', variant: 'destructive' })) {
      await run(async () => {
        await apiDelete(`/channels/${info.id}`)
        onRemoved(info.id)
      })
    }
  }

  return (
    <SettingsCard
      title={info.name}
      actions={
        <div className="flex items-center gap-1">
          <Hint text="Run the script now; its message reaches subscribers as usual">
            <Button size="xs" variant="ghost" disabled={busy} onClick={runNow}>
              <Play />
              Run
            </Button>
          </Hint>
          <Hint text="Change the name, timing or script">
            <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit}>
              <Pencil />
              Edit
            </Button>
          </Hint>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            className={DESTRUCTIVE_ON_INTENT}
            aria-label={`Delete ${info.name}`}
            onClick={() => void remove()}
          >
            <Trash2 />
          </Button>
        </div>
      }
    >
      <SettingRow label="Status" description={statusText(info)}>
        <span className={cn('font-semibold uppercase', status.tone)} data-testid="reminder-status">
          {status.label}
        </span>
      </SettingRow>
      <ScheduleHealth health={reminder.health} />
      <SettingRow label="Schedule" description={timingText(info)}>
        <Switch
          aria-label={`${info.name} schedule`}
          checked={reminder.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => {
            update({ enabled })
          }}
        />
      </SettingRow>
      <Subscribers info={info} onChange={onChange} />
      <Activity info={info} />
    </SettingsCard>
  )
}

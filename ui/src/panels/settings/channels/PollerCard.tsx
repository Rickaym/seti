import type { ChannelInfo, PollerChannelInfo, PollerStatus, PollerUpdateInput } from '@seti/shared'
import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
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
import { STALE } from './schedule-health'

const STATUS: Record<PollerStatus, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'text-muted-foreground' },
  ok: { label: 'OK', tone: 'text-success' },
  erroring: { label: 'Erroring', tone: 'text-warning-text' },
  failing: { label: 'Failing', tone: 'text-destructive' },
  paused: { label: 'Paused', tone: 'text-muted-foreground' },
}

const every = (seconds: number) =>
  seconds % 3600 === 0 ? `${String(seconds / 3600)} h` : `${String(Math.round(seconds / 60))} min`

const nextRun = (iso: string) => {
  const ms = Date.parse(iso) - Date.now()
  return ms > 30_000 ? `in ${durationLabel(ms)}` : 'due now'
}

function statusText(info: PollerChannelInfo): string {
  const { poller } = info
  const last = poller.last_run_at === null ? 'No run yet' : `Last run ${relativeTime(poller.last_run_at)}`
  const next = poller.next_run_at === null ? '' : `; next ${nextRun(poller.next_run_at)}`
  const failures = poller.failures > 0 ? `; ${String(poller.failures)} failed in a row` : ''
  return `${last}${next}${failures}`
}

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/** A poller: its status, schedule and reach, subscribers, and its runs and events folded away. */
export function PollerCard({
  info,
  onChange,
  onRemoved,
  onEdit,
}: {
  info: PollerChannelInfo
  onChange: (next: ChannelInfo) => void
  onRemoved: (id: string) => void
  onEdit: () => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const { poller } = info
  const status = poller.health.stale && poller.status !== 'failing' ? STALE : STATUS[poller.status]

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
  const update = (input: PollerUpdateInput) => {
    void run(async () => {
      onChange(await apiPut<PollerChannelInfo>(`/channels/pollers/${info.id}`, input))
    })
  }
  const pollNow = () => {
    void run(async () => {
      const next = await apiPost<PollerChannelInfo>(`/channels/pollers/${info.id}/poll`, {})
      onChange(next)
      const last = next.poller.runs[0]
      if (last?.ok === false) {
        toast.error(`Poll failed: ${last.error ?? 'unknown error'}`)
      } else {
        toast.success(`Polled: ${String(last?.emitted ?? 0)} new events`)
      }
    })
  }
  const remove = async () => {
    const message = `Delete ${info.name}? Seti stops polling, and its events and runs go with it.`
    if (await confirm({ message, confirmLabel: 'Delete', variant: 'destructive' })) {
      await run(async () => {
        await apiDelete(`/channels/${info.id}`)
        onRemoved(info.id)
      })
    }
  }
  const reach = [
    ...(poller.extra_hosts.length > 0 ? [`hosts ${poller.extra_hosts.join(', ')}`] : []),
    ...(poller.secrets.length > 0 ? [`secrets ${poller.secrets.join(', ')}`] : []),
  ]

  return (
    <SettingsCard
      title={info.name}
      actions={
        <div className="flex items-center gap-1">
          <Hint text="Run the script now; changes reach subscribers as usual">
            <Button size="xs" variant="ghost" disabled={busy} onClick={pollNow}>
              <RefreshCw />
              Poll
            </Button>
          </Hint>
          <Hint text="Change the script, schedule, hosts, secrets or watched fields">
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
        <span className={cn('font-semibold uppercase', status.tone)} data-testid="poller-status">
          {status.label}
        </span>
      </SettingRow>
      <ScheduleHealth health={poller.health} />
      <SettingRow
        label="Schedule"
        description={`Every ${every(poller.interval_s)}, timeout ${String(poller.timeout_s)} s; tracks ${count(poller.keys, 'item')}${poller.detect_gone ? ', reports gone ones' : ''}`}
      >
        <Switch
          aria-label={`${info.name} schedule`}
          checked={poller.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => {
            update({ enabled })
          }}
        />
      </SettingRow>
      {reach.length > 0 && (
        <SettingRow label="Hosts and secrets" description="Beyond the sandbox's allowed hosts" stack>
          <span className="break-all">{reach.join('; ')}</span>
        </SettingRow>
      )}
      <Subscribers info={info} onChange={onChange} />
      <Activity info={info} />
    </SettingsCard>
  )
}

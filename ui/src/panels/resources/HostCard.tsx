import type { Anomaly, AnomalyRule, DiskUsage, HistoryPoint, HostResources } from '@seti/shared'
import type { ReactNode } from 'react'
import { Sparkline } from '@/components/Sparkline'
import { cn } from '@/lib/utils'
import { ageLabel, bytesLabel, percentLabel } from '@/panels/resources/format'
import { SettingsCard } from '@/panels/settings/layout'

function Tile({
  label,
  value,
  detail,
  flagged,
  children,
}: {
  label: string
  value: string
  detail: string
  flagged: boolean
  children?: ReactNode
}) {
  return (
    <div role="group" aria-label={label} className={cn('min-w-0 border-border p-3', flagged && 'bg-warning/10')}>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      <div className="truncate text-muted-foreground tabular-nums" title={detail}>
        {detail}
      </div>
      {children !== undefined && <div className="mt-2">{children}</div>}
    </div>
  )
}

function Meter({ percent, flagged, label }: { percent: number; flagged: boolean; label: string }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-1.5 w-full bg-muted"
    >
      <div
        className={cn('h-full', flagged ? 'bg-warning-fill' : 'bg-primary')}
        style={{ width: `${String(Math.min(100, Math.max(0, percent)))}%` }}
      />
    </div>
  )
}

function DiskRow({ disk, flagged }: { disk: DiskUsage; flagged: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 max-md:grid-cols-1">
      <div className="min-w-0 truncate max-md:whitespace-normal">
        <span className="font-mono">{disk.mount}</span>
        <span className="text-muted-foreground"> holds {disk.holds.join(', ')}</span>
      </div>
      <div className={cn('text-right tabular-nums max-md:text-left', flagged && 'font-semibold text-warning-text')}>
        {percentLabel(disk.used_percent)} used, {bytesLabel(disk.free_bytes)} free of {bytesLabel(disk.total_bytes)}
      </div>
      <div className="col-span-full">
        <Meter percent={disk.used_percent} flagged={flagged} label={`Disk ${disk.mount} used`} />
      </div>
    </div>
  )
}

const percentOf = (part: number, whole: number) => (whole === 0 ? 0 : (100 * part) / whole)

export function HostCard({
  host,
  history,
  anomalies,
}: {
  host: HostResources
  history: readonly HistoryPoint[]
  anomalies: readonly Anomaly[]
}) {
  const has = (rule: AnomalyRule) => anomalies.some((a) => a.rule === rule)
  const { memory, swap } = host
  const [one, five, fifteen] = host.load.map((v) => v.toFixed(1))
  return (
    <SettingsCard title="Host" actions={<span className="text-muted-foreground">up {ageLabel(host.uptime_s)}</span>}>
      <div className="grid grid-cols-3 divide-x divide-border max-md:grid-cols-1 max-md:divide-x-0 max-md:divide-y">
        <Tile
          label="CPU"
          value={percentLabel(host.cpu_percent)}
          detail={`${String(host.cpus)} CPUs, load ${one ?? '-'} ${five ?? '-'} ${fifteen ?? '-'}`}
          flagged={has('load')}
        >
          <Sparkline
            label="Host CPU, last hour"
            points={history.map((p) => ({ at: p.at, value: p.cpu_percent }))}
            format={percentLabel}
            max={100}
          />
        </Tile>
        <Tile
          label="Memory"
          value={percentLabel(percentOf(memory.used_bytes, memory.total_bytes))}
          detail={`${bytesLabel(memory.used_bytes)} of ${bytesLabel(memory.total_bytes)}, ${bytesLabel(memory.available_bytes)} available`}
          flagged={has('host_memory')}
        >
          <Sparkline
            label="Host memory, last hour"
            points={history.map((p) => ({ at: p.at, value: p.memory_percent }))}
            format={percentLabel}
            max={100}
          />
        </Tile>
        <Tile
          label="Swap"
          value={swap.total_bytes === 0 ? 'none' : percentLabel(percentOf(swap.used_bytes, swap.total_bytes))}
          detail={`${bytesLabel(swap.used_bytes)} of ${bytesLabel(swap.total_bytes)}`}
          flagged={has('swap')}
        >
          <Meter percent={percentOf(swap.used_bytes, swap.total_bytes)} flagged={has('swap')} label="Swap used" />
        </Tile>
      </div>
      {host.disks.map((disk) => (
        <DiskRow
          key={disk.mount}
          disk={disk}
          flagged={anomalies.some((a) => a.rule === 'disk' && a.mount === disk.mount)}
        />
      ))}
    </SettingsCard>
  )
}

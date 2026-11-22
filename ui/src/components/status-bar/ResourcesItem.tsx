import type { ResourceSummary } from '@seti/shared'
import { Cpu, TriangleAlert } from 'lucide-react'
import { useContext } from 'react'
import { HypeMeter } from '@/components/resources/HypeMeter'
import { powerBar, type HostMeter, type Power } from '@/components/resources/hype'
import { StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { resourcesTone, RowContext } from '@/components/status-bar/tone'
import { useResourceSummary } from '@/hooks/useResources'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { bytesLabel, percentLabel } from '@/panels/resources/format'

const DRIVER: Record<HostMeter, string> = { cpu: 'CPU', memory: 'Memory' }

function Tooltip({ summary, power }: { summary: ResourceSummary; power: Power }) {
  const count = summary.anomalies
  const warning = power.reasons.length > 0 ? ` as a warning: ${power.reasons.join(', ')}` : ''
  return (
    <span className="grid gap-0.5">
      <span>
        CPU {percentLabel(summary.cpu_percent)}, memory {percentLabel(summary.memory_percent)} of{' '}
        {bytesLabel(summary.memory_total_bytes)}.
      </span>
      <span>
        {DRIVER[power.driver]} drives the bar{warning}.
      </span>
      {count > 0 && (
        <span>
          {count} {count === 1 ? 'anomaly' : 'anomalies'}: {summary.headline}
        </span>
      )}
      <span>Click for resources.</span>
    </span>
  )
}

/** Host CPU and memory as one bar that livens up when either is busy; anomalies add a count. */
export function ResourcesItem() {
  const { data } = useResourceSummary()
  const row = useContext(RowContext) !== null
  if (!data) {
    return null
  }
  const power = powerBar({ cpu: data.cpu_percent, memory: data.memory_percent, rules: data.rules })
  return (
    <StatusBarItem
      label="Resources"
      tone={resourcesTone(data)}
      tooltip={<Tooltip summary={data} power={power} />}
      onClick={() => {
        navigate('settings', 'resources')
      }}
    >
      <span className={cn('flex items-center gap-1', row && 'min-w-0 flex-1')}>
        <Cpu className="size-3 shrink-0" aria-hidden />
        <HypeMeter
          label="Host CPU and memory"
          percent={power.percent}
          state={power.state}
          className={cn(
            'min-w-6 [--hype-flow-pace:steps(12)] [--hype-rage-pace:steps(8)] [--hype-track:color-mix(in_oklch,currentColor_22%,transparent)] [--hype-trouble:currentColor]',
            row ? 'flex-1' : 'w-14',
          )}
        />
      </span>
      {data.anomalies > 0 && (
        <span className="flex items-center gap-0.5" data-testid="resource-anomalies">
          <TriangleAlert className="size-3" aria-hidden />
          {data.anomalies}
        </span>
      )}
    </StatusBarItem>
  )
}

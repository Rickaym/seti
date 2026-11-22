import type { ResourceSummary } from '@seti/shared'
import { Cpu, MemoryStick, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useContext } from 'react'
import { HypeMeter } from '@/components/resources/HypeMeter'
import { inTrouble } from '@/components/resources/hype'
import { StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { resourcesTone, RowContext } from '@/components/status-bar/tone'
import { useResourceSummary } from '@/hooks/useResources'
import { navigate } from '@/lib/route'

const percentText = (value: number | null) => (value === null ? '-' : `${String(Math.round(value))}%`)

function Tooltip({ summary }: { summary: ResourceSummary }) {
  const count = summary.anomalies
  return (
    <span className="grid gap-0.5">
      <span>
        Host memory {percentText(summary.memory_percent)} used, CPU {percentText(summary.cpu_percent)}.
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

interface BarProps {
  icon: LucideIcon
  label: string
  percent: number | null
  trouble: boolean
}

/** Takes the item's colour for track and trouble; steps, since each frame redraws the screen. */
function Bar({ icon: Icon, label, percent, trouble }: BarProps) {
  return (
    <span className="flex items-center gap-1">
      <Icon className="size-3 shrink-0" aria-hidden />
      <HypeMeter
        label={label}
        percent={percent}
        trouble={trouble}
        className="w-7 [--hype-flow-pace:steps(12)] [--hype-rage-pace:steps(8)] [--hype-track:color-mix(in_oklch,currentColor_22%,transparent)] [--hype-trouble:currentColor]"
      />
    </span>
  )
}

/** Host CPU and memory as bars that liven up with use; anomalies add a count, filled if critical. */
export function ResourcesItem() {
  const { data } = useResourceSummary()
  const row = useContext(RowContext) !== null
  if (!data) {
    return null
  }
  const flagged = data.anomalies > 0
  return (
    <StatusBarItem
      label="Resources"
      tone={resourcesTone(data)}
      tooltip={<Tooltip summary={data} />}
      onClick={() => {
        navigate('settings', 'resources')
      }}
    >
      <span className={row ? 'grid gap-1' : 'flex items-center gap-1.5'}>
        <Bar icon={Cpu} label="Host CPU" percent={data.cpu_percent} trouble={inTrouble('cpu', data.rules)} />
        <Bar
          icon={MemoryStick}
          label="Host memory"
          percent={data.memory_percent}
          trouble={inTrouble('memory', data.rules)}
        />
      </span>
      {flagged && (
        <span className="flex items-center gap-0.5" data-testid="resource-anomalies">
          <TriangleAlert className="size-3" aria-hidden />
          {data.anomalies}
        </span>
      )}
    </StatusBarItem>
  )
}

import type { ResourceSummary } from '@seti/shared'
import { Gauge, TriangleAlert } from 'lucide-react'
import { StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { resourcesTone } from '@/components/status-bar/tone'
import { useResourceSummary } from '@/hooks/useResources'
import { navigate } from '@/lib/route'

const percent = (value: number | null) => (value === null ? '-' : `${String(Math.round(value))}%`)

function Tooltip({ summary }: { summary: ResourceSummary }) {
  const count = summary.anomalies
  return (
    <span className="grid gap-0.5">
      <span>
        Host memory {percent(summary.memory_percent)} used, CPU {percent(summary.cpu_percent)}.
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

/** Host memory at a glance; anomalies add a warning count, filled once one is critical. */
export function ResourcesItem() {
  const { data } = useResourceSummary()
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
      <Gauge className="size-3" />
      <span>{percent(data.memory_percent)}</span>
      {flagged && (
        <span className="flex items-center gap-0.5" data-testid="resource-anomalies">
          <TriangleAlert className="size-3" aria-hidden />
          {data.anomalies}
        </span>
      )}
    </StatusBarItem>
  )
}

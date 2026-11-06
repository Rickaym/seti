import type { Anomaly } from '@seti/shared'
import { OctagonAlert, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Everything flagged now, the most severe first; a task's anomaly links to the task. */
export function AnomalyList({ anomalies }: { anomalies: readonly Anomaly[] }) {
  if (anomalies.length === 0) {
    return null
  }
  return (
    <section aria-label="Anomalies" className="border border-border bg-card text-xs">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">
        {anomalies.length} {anomalies.length === 1 ? 'anomaly' : 'anomalies'}
      </h3>
      <ul>
        {anomalies.map((anomaly, i) => {
          const critical = anomaly.severity === 'critical'
          const Icon = critical ? OctagonAlert : TriangleAlert
          return (
            <li
              key={`${anomaly.rule}-${String(i)}`}
              className={cn(
                'flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0',
                critical ? 'bg-destructive/10' : 'bg-warning/10',
              )}
            >
              <Icon
                className={cn('mt-px size-3.5 shrink-0', critical ? 'text-destructive' : 'text-warning-text')}
                role="img"
                aria-label={anomaly.severity}
              />
              {anomaly.task_id === null ? (
                <span className="min-w-0">{anomaly.message}</span>
              ) : (
                <a href={`#agents/${anomaly.task_id}`} className="min-w-0 hover:underline">
                  {anomaly.message}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

import { useResources } from '@/hooks/useResources'
import { AnomalyList } from '@/panels/resources/AnomalyList'
import { ComponentsCard } from '@/panels/resources/ComponentsCard'
import { HostCard } from '@/panels/resources/HostCard'
import { TasksCard } from '@/panels/resources/TasksCard'
import { CpuCapCard } from './CpuCapCard'
import { MemoryCapCard } from './MemoryCapCard'
import { SettingsBody, SettingsHeader } from './layout'

export function ResourcesPage() {
  const { data, error } = useResources()
  const sampled = data === undefined ? null : new Date(data.sampled_at).toLocaleTimeString()
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="Resources"
          description="What this host, Seti's services and each agent's Claude Code use, sampled every 10 s, and each agent's memory and CPU caps."
          actions={
            sampled === null ? undefined : <span className="text-xs text-muted-foreground">Sampled {sampled}</span>
          }
        />
      }
    >
      {error !== null && (
        <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="mb-4 space-y-4">
        <MemoryCapCard />
        <CpuCapCard />
      </div>
      {data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <div className="space-y-4">
          <AnomalyList anomalies={data.anomalies} />
          <HostCard host={data.host} history={data.history} anomalies={data.anomalies} />
          <TasksCard resources={data} />
          <ComponentsCard components={data.components} />
          <p className="text-xs text-muted-foreground">
            The sampler reads /proc every {data.interval_s} s and keeps the last hour; each sample takes{' '}
            {data.sampler.wall_ms.toFixed(1)} ms, {data.sampler.cpu_ms.toFixed(1)} ms of it on the CPU.
          </p>
        </div>
      )}
    </SettingsBody>
  )
}

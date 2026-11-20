import { useStorage } from '@/hooks/useStorage'
import { bytesLabel } from '@/panels/resources/format'
import { OrphansCard } from './OrphansCard'
import { StorageAgentsCard } from './StorageAgentsCard'
import { StorageScheduleCard } from './StorageScheduleCard'
import { SettingsBody, SettingsHeader } from './layout'

/** What each agent's folders take on disk, what Clean can free, and folders no agent owns. */
export function StoragePage() {
  const { data, error } = useStorage()
  const disk = data?.disk ?? null
  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="Storage"
          description="What each agent's folders take on disk, what a reinstall or build can make again, and folders no agent owns."
        />
      }
    >
      {error !== null && (
        <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <div className="space-y-4">
          <section aria-label="Totals" className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span>
              <span className="font-semibold tabular-nums">{bytesLabel(data.total_bytes)}</span> in agents' folders
            </span>
            <span>
              <span className="font-semibold tabular-nums">{bytesLabel(data.rebuildable_bytes)}</span> rebuildable
            </span>
            {disk !== null && (
              <span title={disk.path}>
                <span className="font-semibold tabular-nums">{bytesLabel(disk.free_bytes)}</span> free of{' '}
                {bytesLabel(disk.total_bytes)}
              </span>
            )}
            {data.measuring && <span className="text-xs text-muted-foreground">Measuring...</span>}
          </section>
          <StorageScheduleCard schedule={data.schedule} />
          <StorageAgentsCard agents={data.agents} />
          <OrphansCard orphans={data.orphans} />
        </div>
      )}
    </SettingsBody>
  )
}

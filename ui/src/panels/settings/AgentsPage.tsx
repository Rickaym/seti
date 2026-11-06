import { AutoArchiveCard } from './AutoArchiveCard'
import { CompactCard } from './CompactCard'
import { RestartCard } from './RestartCard'
import { StaleFoldersCard } from './StaleFoldersCard'
import { SettingsBody, SettingsHeader } from './layout'

/** Compaction, resuming after a restart, and archiving, deleting and clearing agents' folders. */
export function AgentsPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Lifecycle"
          description="When agents compact, resume after a restart, and when Seti archives and deletes them and clears their folders."
        />
      }
    >
      <div className="space-y-4">
        <CompactCard />
        <RestartCard />
        <AutoArchiveCard />
        <StaleFoldersCard />
      </div>
    </SettingsBody>
  )
}

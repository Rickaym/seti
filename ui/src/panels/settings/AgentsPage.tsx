import { AutoArchiveCard } from './AutoArchiveCard'
import { CompactCard } from './CompactCard'
import { RepeatGuardCard, RestartCard } from './LifecycleToggles'
import { StaleFoldersCard } from './StaleFoldersCard'
import { SettingsBody, SettingsHeader } from './layout'

/** Compaction, resuming after a restart, repeated calls, and archiving and clearing agents. */
export function AgentsPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Lifecycle"
          description="When agents compact, resume after a restart or stop to ask about repeated calls, and when Seti archives and deletes them and clears their folders."
        />
      }
    >
      <div className="space-y-4">
        <CompactCard />
        <RestartCard />
        <RepeatGuardCard />
        <AutoArchiveCard />
        <StaleFoldersCard />
      </div>
    </SettingsBody>
  )
}

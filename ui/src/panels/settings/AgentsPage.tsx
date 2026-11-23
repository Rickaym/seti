import { AutoArchiveCard } from './AutoArchiveCard'
import { CompactCard } from './CompactCard'
import { DreamingCard } from './DreamingCard'
import { RepeatGuardCard, RestartCard } from './LifecycleToggles'
import { SettingsBody, SettingsHeader } from './layout'

/** Compaction, resuming after a restart, repeated calls, archiving and deleting, and Dreaming. */
export function AgentsPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Lifecycle"
          description="When agents compact, resume after a restart or stop to ask about repeated calls, when Seti archives and deletes them, and when they dream."
        />
      }
    >
      <div className="space-y-4">
        <CompactCard />
        <RestartCard />
        <RepeatGuardCard />
        <AutoArchiveCard />
        <DreamingCard />
      </div>
    </SettingsBody>
  )
}

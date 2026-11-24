import { CodexCard } from './CodexCard'
import { SettingsBody, SettingsHeader } from './layout'

/** The programs agents run on besides Claude Code, each off until the user sets it up. */
export function RuntimesPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Runtimes"
          description="The programs agents run on. Claude Code is always there; Codex stays off until you turn it on."
        />
      }
    >
      <div className="space-y-4">
        <CodexCard />
      </div>
    </SettingsBody>
  )
}

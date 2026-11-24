import { ClaudeCard } from './ClaudeCard'
import { CodexCard } from './CodexCard'
import { SettingsBody, SettingsHeader } from './layout'

/** The programs agents run on: Claude Code, and Codex once the user turns it on. */
export function RuntimesPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Runtimes"
          description="The programs agents run on, each with its login, usage and defaults. Codex stays off until you turn it on."
        />
      }
    >
      <div className="space-y-4">
        <ClaudeCard />
        <CodexCard />
      </div>
    </SettingsBody>
  )
}

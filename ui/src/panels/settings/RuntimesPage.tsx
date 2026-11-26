import { ClaudeCard } from './ClaudeCard'
import { CodexCard } from './CodexCard'
import { GeminiCard } from './GeminiCard'
import { SettingsBody, SettingsHeader } from './layout'

/** The programs agents run on: Claude Code, and Codex and Gemini once the user turns them on. */
export function RuntimesPage() {
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Runtimes"
          description="The programs agents run on, each with its login, usage and defaults. Codex and Gemini stay off until you turn them on."
        />
      }
    >
      <div className="space-y-4">
        <ClaudeCard />
        <CodexCard />
        <GeminiCard />
      </div>
    </SettingsBody>
  )
}

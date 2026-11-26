import type { AgentSettingTab, Task } from '@seti/shared'

/** Where a command that opens something goes: a tab of the agent's settings, or its access. */
export type SettingsTarget = AgentSettingTab | 'access'

/** A request to open the agent's settings, new each time so the same tab can open twice. */
export interface SettingsRequest {
  target: SettingsTarget
  at: number
}

/** What the agent's view lends its composer for running a Seti command. */
export interface CommandHost {
  task: Task
  /** A turn runs, which a restart stops first. */
  running: boolean
  onChanged: () => void
  openSettings: (target: SettingsTarget) => void
  /** Opens the agent's name for editing, as Rename in its menu does. */
  startRename: () => void
}

import type { AgentCapabilities, AgentSettingTab, ProfileSummary, Task } from '@seti/shared'
import type { ConfirmOptions } from '@/components/ui/confirm-context'

/** Where `/settings` and `/access` take the user: a tab of the agent's settings, or its access. */
type SettingsTarget = AgentSettingTab | 'access'

/** A request to open the agent's settings, new each time so the same tab can open twice. */
export interface SettingsRequest {
  target: SettingsTarget
  at: number
}

/** What the agent's view lends its composer for running a setting command. */
export interface CommandHost {
  task: Task
  /** A turn runs, which a restart stops first. */
  running: boolean
  /** A turn, shell command or background job runs, so the agent cannot be archived yet. */
  busy: boolean
  onChanged: () => void
  openSettings: (target: SettingsTarget) => void
  /** Opens the agent's name for editing, as Rename in its menu does. */
  startRename: () => void
}

/** The host with what the composer adds: the runtime's capabilities and the credential switch. */
export interface CommandContext extends CommandHost {
  caps: AgentCapabilities | null
  /** Whether the sandbox is on in Settings, so an agent's own switch means anything. */
  sandboxOn: boolean
  switchCredential: (id: string, profile: ProfileSummary | undefined) => void
}

/** One choice a picker offers: the words it puts after the command's name. */
export interface Choice {
  args: string
  label: string
  detail: string | null
  current: boolean
}

/** What a setting command does with the words typed after its name. */
export type CommandStep =
  | { kind: 'choose'; prompt: string; choices: readonly Choice[] }
  | { kind: 'confirm'; question: ConfirmOptions; run: () => Promise<boolean> }
  | { kind: 'run'; run: () => Promise<boolean> }
  | { kind: 'refuse'; reason: string }

/** The steps of a command once what it reads, such as the MCP servers, has loaded. */
export type Stepper = (args: string) => CommandStep

/** How one setting command runs: the cog's own actions, reached from the composer. */
export type CommandBinding = (context: CommandContext) => Promise<Stepper>

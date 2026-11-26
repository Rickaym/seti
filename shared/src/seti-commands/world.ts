import type { AccessItem, TaskAccessView } from '../access.js'
import type { TaskCpuCap } from '../cpu.js'
import type { ProfileSummary } from '../credentials.js'
import type { TaskMemoryCap } from '../memory.js'
import type { AgentCapabilities } from '../runtimes/capabilities.js'
import type { Task } from '../tasks.js'
import type { OpRule } from './rules.js'

/** Who a line is checked for: the user at the reply box, or an agent proposing it for itself. */
export type CommandAuthor = 'user' | 'agent'

/** What a line is checked against; a source left null has not loaded and offers nothing yet. */
export interface CommandWorld {
  author: CommandAuthor
  task: Pick<
    Task,
    | 'title'
    | 'sandbox'
    | 'home_access'
    | 'profile_id'
    | 'seti_control'
    | 'bypass_until'
    | 'pinned'
    | 'notifications_muted'
    | 'input_mode'
    | 'color'
    | 'workspace_id'
  >
  caps: AgentCapabilities | null
  /** The sandbox is on in Settings, so the agent's own switch means something. */
  sandboxOn: boolean
  access: TaskAccessView | null
  credentials: readonly ProfileSummary[] | null
  workspaces: readonly { id: string; name: string }[] | null
  memory: Pick<TaskMemoryCap, 'override' | 'effective'> | null
  cpu: { cap: Pick<TaskCpuCap, 'override' | 'effective'>; max_percent: number } | null
}

/** The sources a command reads beyond the agent itself. */
export type CommandSource = 'access' | 'credentials' | 'workspaces' | 'memory' | 'cpu'

/** One choice at a step: the word the line takes, with what the menu shows beside it. */
export interface CommandOption {
  token: string
  /** What the command holds for it: an item's id, else the token. */
  key: string
  label: string
  /** One line: what it does, or the item's state and where it comes from. */
  detail: string | null
  current: boolean
  /** Why it cannot be picked here; null when it can. */
  unavailable: string | null
}

/** What the next word of a line may be. */
export type GrammarStep =
  | {
      kind: 'choose'
      prompt: string
      options: readonly CommandOption[]
      /** Checks a word that is not among the options; null when only the options fit. */
      free: ((word: string) => FreeWord) | null
      /** The rule when the line may end here instead; null when it needs one of the options. */
      endRule: OpRule | null
    }
  | { kind: 'rest'; prompt: string; max: number; rule: OpRule }
  | { kind: 'end'; rule: OpRule }

/** A free word, checked: why it is refused, or the option it stands for. */
export type FreeWord = { refusal: string } | { option: CommandOption }

/** Where an access item's state comes from, as the access dialog marks it. */
export function itemSource(item: AccessItem): string {
  if (item.override !== null) {
    return 'Custom'
  }
  return item.credential === null ? 'Inherited' : 'Credential'
}

export const option = (fields: Partial<CommandOption> & Pick<CommandOption, 'token' | 'label'>): CommandOption => ({
  key: fields.token,
  detail: null,
  current: false,
  unavailable: null,
  ...fields,
})

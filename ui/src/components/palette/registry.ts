import type { TaskListEntry } from '@seti/shared'
import type { ComponentType } from 'react'
import type { Route } from '@/lib/route'

/** What a command can see when the palette asks whether it applies and when it runs. */
export interface CommandContext {
  route: Route
  /** The live agent the page shows, or null when none is open. */
  agent: TaskListEntry | null
}

/** Groups in the order the palette lists them. */
const COMMAND_GROUPS = ['Current agent', 'General', 'View', 'Settings'] as const
type CommandGroup = (typeof COMMAND_GROUPS)[number]

export interface PaletteCommand {
  /** Stable across renders and unique in the app, such as `agent.stop`. */
  id: string
  title: string
  /** A second line, such as the agent a command acts on. */
  detail?: string
  icon: ComponentType<{ className?: string }>
  group: CommandGroup
  /** Other words that should find it, matched but not shown. */
  keywords?: string
  /** The key combination that also runs it, shown as a hint. */
  shortcut?: string
  /** Its title here, when it reads differently by state; `title` still finds it. */
  titleFor?: (context: CommandContext) => string
  /** Leaves the command out when false; it applies everywhere without one. */
  when?: (context: CommandContext) => boolean
  run: (context: CommandContext) => void
}

/** Commands from every feature; a later registration under the same id replaces the earlier. */
export class CommandRegistry {
  private commands = new Map<string, PaletteCommand>()
  private snapshot: readonly PaletteCommand[] = []
  private readonly listeners = new Set<() => void>()

  /** Adds `commands` and returns what removes them again. */
  register = (commands: readonly PaletteCommand[]): (() => void) => {
    const next = new Map(this.commands)
    for (const command of commands) {
      next.set(command.id, command)
    }
    this.update(next)
    return () => {
      const rest = new Map(this.commands)
      for (const command of commands) {
        if (rest.get(command.id) === command) {
          rest.delete(command.id)
        }
      }
      this.update(rest)
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly PaletteCommand[] => this.snapshot

  private update(next: Map<string, PaletteCommand>): void {
    this.commands = next
    this.snapshot = [...next.values()]
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const groupRank = (group: CommandGroup) => COMMAND_GROUPS.indexOf(group)

/** The commands that apply in `context`, by group and then by title. */
export function availableCommands(commands: readonly PaletteCommand[], context: CommandContext): PaletteCommand[] {
  return commands
    .filter((command) => command.when?.(context) ?? true)
    .sort((a, b) => (a.group === b.group ? a.title.localeCompare(b.title) : groupRank(a.group) - groupRank(b.group)))
}

export const commandRegistry = new CommandRegistry()

import { COMMAND_SETTINGS, meetsNeeds, type CommandSettingId, type Task } from '@seti/shared'
import {
  Archive,
  FastForward,
  KeyRound,
  Pencil,
  Plug,
  RotateCw,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useCommands } from '@/components/palette/useCommands'
import { useCapabilities } from '@/hooks/useCapabilities'

const ICONS: Readonly<Record<CommandSettingId, LucideIcon>> = {
  credential: KeyRound,
  access: SlidersHorizontal,
  mcp: Plug,
  sandbox: Shield,
  bypass: FastForward,
  dream: Sparkles,
  restart: RotateCw,
  archive: Archive,
  rename: Pencil,
  settings: Settings,
}

/**
 * Offers the agent's setting commands in the palette, from the same registry as its reply box: a
 * pick runs the command as if typed in the box, where its choices or question show.
 */
export function useCommandPalette(task: Task, fill: (text: string) => void): void {
  const caps = useCapabilities(task)
  useCommands(
    COMMAND_SETTINGS.filter((entry) => meetsNeeds(caps, entry.needs)).map((entry) => ({
      id: `agent.command.${entry.id}`,
      title: `/${entry.command.name}`,
      detail: entry.command.description,
      icon: ICONS[entry.id],
      group: 'Current agent',
      keywords: entry.label,
      when: (context) => context.agent?.id === task.id,
      run: () => {
        fill(`/${entry.command.name} `)
      },
    })),
  )
}

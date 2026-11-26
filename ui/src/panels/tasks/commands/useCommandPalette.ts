import { meetsNeeds, SETI_NAMES, type Task } from '@seti/shared'
import {
  Archive,
  FastForward,
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

const ICONS: Readonly<Record<string, LucideIcon>> = {
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
 * Offers the agent's Seti commands in the palette, from the same grammar as its reply box: a pick
 * puts the command in the box, where its choices complete each word.
 */
export function useCommandPalette(task: Task, fill: (text: string) => void): void {
  const caps = useCapabilities(task)
  useCommands(
    SETI_NAMES.filter((entry) => meetsNeeds(caps, entry.entry.needs)).map((entry) => ({
      id: `agent.command.${entry.name}`,
      title: `/seti:${entry.name}`,
      detail: entry.description,
      icon: ICONS[entry.name] ?? Settings,
      group: 'Current agent',
      keywords: entry.entry.label,
      when: (context) => context.agent?.id === task.id,
      run: () => {
        fill(`/seti:${entry.name} `)
      },
    })),
  )
}

import type { Task } from '@seti/shared'
import { KeyRound, Layers, UserCog } from 'lucide-react'
import { useState } from 'react'
import { useCommands } from '@/components/palette/useCommands'
import type { SettingsRequest } from '@/panels/tasks/commands/types'

export type SectionId = 'general' | 'access' | 'team' | 'session'

/**
 * Whether the agent's settings and its access dialog are open, on which tab and with which field
 * focused; the palette's agent commands and a setting command's request open them too.
 */
export function useCogState(task: Task, request: SettingsRequest | null) {
  const [open, setOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [roleFocus, setRoleFocus] = useState(false)
  const [workspaceFocus, setWorkspaceFocus] = useState(false)
  const [section, setSection] = useState<SectionId>('general')
  const [seenRequest, setSeenRequest] = useState(request)
  if (request !== seenRequest) {
    setSeenRequest(request)
    if (request?.target === 'access') {
      setAccessOpen(true)
    } else if (request !== null) {
      setSection(request.target)
      setOpen(true)
    }
  }
  useCommands([
    {
      id: 'agent.access',
      title: 'Open access',
      detail: task.title,
      icon: KeyRound,
      group: 'Current agent',
      keywords: 'ssh aws mcp servers packs plugins permissions',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setAccessOpen(true)
      },
    },
    {
      id: 'agent.role',
      title: 'Change role',
      detail: task.title,
      icon: UserCog,
      group: 'Current agent',
      keywords: 'role pack system prompt standing instructions lead delegate reviewer watcher',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setSection('general')
        setRoleFocus(true)
        setOpen(true)
      },
    },
    {
      id: 'agent.workspace',
      title: 'Move to workspace...',
      detail: task.title,
      icon: Layers,
      group: 'Current agent',
      keywords: 'workspace move group',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setSection('general')
        setWorkspaceFocus(true)
        setOpen(true)
      },
    },
  ])
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    setRoleFocus(false)
    setWorkspaceFocus(false)
  }
  return { open, setOpen, section, setSection, accessOpen, setAccessOpen, roleFocus, workspaceFocus, onOpenChange }
}

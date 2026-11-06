import { Layers, Plus } from 'lucide-react'
import { useState } from 'react'
import { useCommands } from '@/components/palette/useCommands'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { NewWorkspaceDialog } from './WorkspaceSwitcher'
import { switchWorkspace } from './workspace-actions'

/** Palette commands that switch to each other workspace or make a new one, from any section. */
export function WorkspaceCommands() {
  const { workspaces, current } = useCurrentWorkspace()
  const [creating, setCreating] = useState(false)
  useCommands([
    ...workspaces
      .filter((workspace) => workspace.id !== current?.id)
      .map((workspace) => ({
        id: `workspace.switch.${workspace.id}`,
        title: `Switch to ${workspace.name}`,
        detail: 'Workspace',
        icon: Layers,
        group: 'General' as const,
        keywords: 'workspace go open',
        run: () => {
          switchWorkspace(workspace.id)
        },
      })),
    {
      id: 'workspace.new',
      title: 'New workspace',
      icon: Plus,
      group: 'General',
      keywords: 'create add workspace',
      run: () => {
        setCreating(true)
      },
    },
  ])
  return creating ? (
    <NewWorkspaceDialog
      onClose={() => {
        setCreating(false)
      }}
    />
  ) : null
}

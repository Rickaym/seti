import type { Task } from '@seti/shared'
import { useEffect, useRef } from 'react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { moveAgent } from './workspace-actions'

interface WorkspaceSelectProps {
  task: Pick<Task, 'id' | 'workspace_id'>
  /** Focuses the select once it can take a choice, as the palette's move command asks. */
  focus?: boolean
  onMoved?: () => void
}

/** Moves the agent to another workspace. */
export function WorkspaceSelect({ task, focus = false, onMoved }: WorkspaceSelectProps) {
  const { workspaces, loaded } = useCurrentWorkspace()
  const select = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (focus && loaded) {
      select.current?.focus()
    }
  }, [focus, loaded])
  return (
    <NativeSelect
      ref={select}
      aria-label="Workspace"
      size="sm"
      value={task.workspace_id}
      disabled={!loaded}
      onChange={(event) => {
        const target = workspaces.find((workspace) => workspace.id === event.target.value)
        if (target !== undefined) {
          void moveAgent(task, target).then(onMoved)
        }
      }}
    >
      {workspaces.map((workspace) => (
        <NativeSelectOption key={workspace.id} value={workspace.id}>
          {workspace.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

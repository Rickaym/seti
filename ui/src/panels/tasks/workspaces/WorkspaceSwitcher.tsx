import type { WorkspaceEntry } from '@seti/shared'
import { ChevronsUpDown, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Hint } from '@/components/Hint'
import { useConfirm } from '@/components/ui/confirm-context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTasks } from '@/hooks/useTasks'
import { WorkspaceNameDialog } from './WorkspaceNameDialog'
import { createWorkspace, deleteWorkspace, renameWorkspace, switchWorkspace } from './workspace-actions'
import { needsYouByWorkspace } from './workspace-store'

type Naming = { kind: 'new' } | { kind: 'rename'; workspace: WorkspaceEntry }

const needLabel = (count: number) => `${String(count)} ${count === 1 ? 'needs' : 'need'} you`

/** Opens the dialog that names a new workspace, from the switcher or the palette. */
export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  return (
    <WorkspaceNameDialog
      title="New workspace"
      initial=""
      confirmLabel="Create"
      onSubmit={createWorkspace}
      onClose={onClose}
    />
  )
}

interface WorkspaceSwitcherProps {
  workspaces: readonly WorkspaceEntry[]
  current: WorkspaceEntry | null
}

/** The workspace the agent list shows, with the others, new, rename and delete in its menu. */
export function WorkspaceSwitcher({ workspaces, current }: WorkspaceSwitcherProps) {
  const confirm = useConfirm()
  const { tasks } = useTasks()
  const waiting = useMemo(() => needsYouByWorkspace(tasks), [tasks])
  const [naming, setNaming] = useState<Naming | null>(null)
  const name = current?.name ?? 'Workspace'

  const remove = async (workspace: WorkspaceEntry) => {
    const ok = await confirm({
      title: 'Delete workspace',
      message: `Delete the workspace "${workspace.name}"?`,
      detail: 'Seti deletes only an empty workspace; move or delete its agents first, archived ones included.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    })
    if (ok) {
      await deleteWorkspace(workspace)
    }
  }

  return (
    <div className="border-b border-border px-1.5 py-1">
      <DropdownMenu modal={false}>
        <Hint text="Switch workspace">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Workspace: ${name}`}
              className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-left text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
            >
              <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) max-w-[min(20rem,90vw)]">
          <DropdownMenuRadioGroup
            value={current?.id ?? ''}
            onValueChange={(id) => {
              if (id !== current?.id) {
                switchWorkspace(id)
              }
            }}
          >
            {workspaces.map((workspace) => {
              const count = workspace.id === current?.id ? 0 : (waiting.get(workspace.id) ?? 0)
              return (
                <DropdownMenuRadioItem
                  key={workspace.id}
                  value={workspace.id}
                  aria-label={count > 0 ? `${workspace.name}, ${needLabel(count)}` : workspace.name}
                >
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {count > 0 && (
                    <span className="shrink-0 text-2xs text-destructive tabular-nums" title={needLabel(count)}>
                      {count}
                    </span>
                  )}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setNaming({ kind: 'new' })
            }}
          >
            <Plus />
            New workspace
          </DropdownMenuItem>
          {current !== null && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  setNaming({ kind: 'rename', workspace: current })
                }}
              >
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(current)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {naming?.kind === 'new' && (
        <NewWorkspaceDialog
          onClose={() => {
            setNaming(null)
          }}
        />
      )}
      {naming?.kind === 'rename' && (
        <WorkspaceNameDialog
          title="Rename workspace"
          initial={naming.workspace.name}
          confirmLabel="Save"
          onSubmit={async (next) => renameWorkspace(naming.workspace.id, next)}
          onClose={() => {
            setNaming(null)
          }}
        />
      )}
    </div>
  )
}

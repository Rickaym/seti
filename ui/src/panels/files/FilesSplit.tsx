import { FolderOpen } from 'lucide-react'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ToggleButton } from '@/components/ToggleButton'
import { ResizablePane } from '@/components/resize/ResizablePane'
import { useOutsideDismiss } from '@/hooks/useOutsideDismiss'
import { PANES } from '@/lib/pane-size'
import { FileLinksContext } from '@/panels/files/file-links'
import { useFilesDock, type FilesDock } from '@/panels/files/files-dock'
import type { FilesPane } from '@/panels/files/useFilesPane'

const FilesPanel = lazy(async () => import('@/panels/files/FilesPanel').then((m) => ({ default: m.FilesPanel })))

interface FilesSplitProps {
  taskId: string
  pane: FilesPane
  readOnly: boolean
  children: ReactNode
}

function FilesBody({ taskId, pane, readOnly }: Omit<FilesSplitProps, 'children'>) {
  if (pane.request === null) {
    return null
  }
  return (
    <ErrorBoundary name="Files" resetKey={taskId}>
      <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading files...</p>}>
        <FilesPanel taskId={taskId} request={pane.request} readOnly={readOnly} onClose={pane.close} />
      </Suspense>
    </ErrorBoundary>
  )
}

/** In a frame under a Files dock, Files opens in that dock, which one agent holds at a time. */
function DockedFiles({ dock, ...props }: Omit<FilesSplitProps, 'children'> & { dock: FilesDock }) {
  const { taskId, pane } = props
  const open = pane.request !== null
  const { claim, release, owner } = dock
  useEffect(() => {
    if (!open) {
      return undefined
    }
    claim(taskId)
    return () => {
      release(taskId)
    }
  }, [open, taskId, claim, release])
  const taken = owner !== null && owner !== taskId
  const { close, setOpen } = pane
  useEffect(() => {
    if (taken) {
      close()
    }
  }, [taken, close])
  useOutsideDismiss(open && owner === taskId, {
    inside: () => dock.element?.closest('[data-files-dock]') ?? null,
    state: pane.request,
    onDismiss: () => {
      setOpen(false)
    },
  })
  if (!open || owner !== taskId || dock.element === null) {
    return null
  }
  return createPortal(<FilesBody {...props} />, dock.element)
}

/** The agent's page beside its Files panel; below md the panel covers the screen while open. */
export function FilesSplit({ taskId, pane, readOnly, children }: FilesSplitProps) {
  const dock = useFilesDock()
  return (
    <FileLinksContext.Provider value={pane.links}>
      <div className="flex h-full min-h-0">
        {children}
        {dock !== null && <DockedFiles dock={dock} taskId={taskId} pane={pane} readOnly={readOnly} />}
        {dock === null && pane.request !== null && (
          <ResizablePane
            spec={PANES.files}
            side="end"
            label="Resize files"
            className="border-l border-border max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:max-w-none max-md:border-l-0 max-md:pt-[env(safe-area-inset-top)] max-md:pr-[env(safe-area-inset-right)] max-md:pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)]"
          >
            <FilesBody taskId={taskId} pane={pane} readOnly={readOnly} />
          </ResizablePane>
        )}
      </div>
    </FileLinksContext.Provider>
  )
}

export function FilesToggle({ pane, variant = 'outline' }: { pane: FilesPane; variant?: 'outline' | 'ghost' }) {
  const open = pane.request !== null
  return (
    <ToggleButton
      pressed={open}
      onPressedChange={pane.setOpen}
      icon={FolderOpen}
      label="Files"
      iconOnly
      wideLabel
      variant={variant}
      hint={open ? 'Close Files' : 'Files: what the agent wrote, PDFs to read and notes to edit together'}
    />
  )
}

import type { ReactNode } from 'react'
import { ResizablePane } from '@/components/resize/ResizablePane'
import { PANES } from '@/lib/pane-size'
import { cn } from '@/lib/utils'
import { FilesDockContext, useFilesDockOwner } from '@/panels/files/files-dock'

interface FilesDockHostProps {
  /** The name the dock shows above the Files of the agent that holds it. */
  titleOf: (taskId: string) => string
  children: ReactNode
}

/** Lets the framed agents inside it open Files in one shared dock over its right edge. */
export function FilesDockHost({ titleOf, children }: FilesDockHostProps) {
  const { dock, setElement } = useFilesDockOwner()
  const title = dock.owner === null ? '' : titleOf(dock.owner)
  return (
    <FilesDockContext value={dock}>
      <div className="relative flex min-h-0 flex-1">
        {children}
        <ResizablePane
          spec={PANES.files}
          side="end"
          label="Resize files"
          className={cn(
            'absolute inset-y-0 right-0 z-30 flex flex-col border-l border-border bg-background shadow-xl',
            dock.owner === null && 'hidden',
          )}
          data-files-dock
        >
          <p className="truncate border-b border-border px-3 py-1 text-2xs text-muted-foreground" title={title}>
            {title}
          </p>
          <div ref={setElement} className="min-h-0 flex-1" />
        </ResizablePane>
      </div>
    </FilesDockContext>
  )
}

import type { ModFileViewProps } from '@seti/mod-api'
import { Suspense } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { cn } from '@/lib/utils'
import { useViewTheme } from '@/lib/view-theme'
import { MONO } from '@/panels/files/PlainText'
import type { FileViewerEntry } from '@/panels/files/file-viewers'

/** The open file as every viewer gets it; `page` is null for a viewer that did not ask for one. */
export type ViewerFile = Omit<ModFileViewProps, 'text' | 'editing' | 'theme'>

/** A viewer showing one file in a pane that scrolls; a viewer that crashes says so in its place. */
export function FileView({
  viewer,
  file,
  text,
  editing = false,
}: {
  viewer: FileViewerEntry
  file: ViewerFile
  text: string | null
  editing?: boolean
}) {
  const theme = useViewTheme()
  const View = viewer.view
  const shown = viewer.text ? text : null
  const loading =
    shown === null ? (
      <p className="p-4 text-sm text-muted-foreground">Loading the viewer...</p>
    ) : (
      <pre className={cn(MONO, 'px-4 py-3 whitespace-pre-wrap')}>{shown}</pre>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <ErrorBoundary name={`The ${viewer.title} viewer`} kind="panel" resetKey={`${viewer.key} ${file.mtime}`}>
        <Suspense fallback={loading}>
          <View {...file} page={viewer.page ? file.page : null} text={shown} editing={editing} theme={theme} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

import type { FileStamp } from '@seti/shared'
import { RefreshCw, TriangleAlert, Upload } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

/** Says the file changed or went away on disk, with Reload and Overwrite. */
export function ConflictBanner({
  stamp,
  onReload,
  onOverwrite,
}: {
  stamp: FileStamp
  onReload: () => void
  onOverwrite: () => void
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning-text" />
      <span className="min-w-0 flex-1">
        {stamp.exists
          ? 'Changed on disk since you opened it, probably by the agent.'
          : 'Deleted on disk since you opened it.'}
      </span>
      {stamp.exists && (
        <Hint text="Load the version on disk and drop your edits">
          <Button variant="outline" size="xs" onClick={onReload}>
            <RefreshCw />
            Reload
          </Button>
        </Hint>
      )}
      <Hint text={stamp.exists ? 'Save your version over the one on disk' : 'Save your version again'}>
        <Button variant="outline" size="xs" onClick={onOverwrite}>
          <Upload />
          Overwrite
        </Button>
      </Hint>
    </div>
  )
}

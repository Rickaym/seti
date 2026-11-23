import { UPLOAD_STALL_MS } from '@seti/shared'
import { TriangleAlert } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Progress } from '@/components/ui/progress'
import { percentOf, sentOf, type UploadState } from '@/lib/upload-state'
import { cn } from '@/lib/utils'

const STALL_SECONDS = String(UPLOAD_STALL_MS / 1000)

const LABEL = 'flex shrink-0 items-center gap-1 whitespace-nowrap'

/** What a chip says while its file is not on the server: a percentage, Stalled, or why it failed. */
export function UploadStatus({ name, upload }: { name: string; upload: UploadState }) {
  if (upload.phase === 'failed') {
    return (
      <Hint text={upload.failure.reason}>
        <span className={cn(LABEL, 'text-destructive')}>
          <TriangleAlert className="size-3 shrink-0" aria-label="Upload failed" />
          {upload.failure.label}
        </span>
      </Hint>
    )
  }
  const stalled = upload.phase === 'stalled'
  const percent = percentOf(upload)
  const waiting = upload.sent >= upload.total ? '; Seti is checking the file' : ''
  const detail = stalled
    ? `No data has moved for ${STALL_SECONDS} seconds; ${sentOf(upload)}. Retry, or drop the file.`
    : `${sentOf(upload)}${waiting}`
  return (
    <>
      <Hint text={detail}>
        <span className={cn(LABEL, stalled ? 'text-warning-text' : 'text-muted-foreground tabular-nums')}>
          {stalled && <TriangleAlert className="size-3 shrink-0" aria-hidden />}
          {stalled ? 'Stalled' : `${String(percent)}%`}
        </span>
      </Hint>
      <Progress
        value={percent}
        aria-label={`${stalled ? 'Stalled' : 'Uploading'} ${name}`}
        aria-valuetext={`${String(percent)}%, ${sentOf(upload)}`}
        className={cn(
          'absolute inset-x-0 bottom-0 h-0.5 bg-transparent',
          stalled && '*:data-[slot=progress-indicator]:bg-warning-fill',
        )}
      />
    </>
  )
}

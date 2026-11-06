import type { FileMeta } from '@seti/shared'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useNarrow } from '@/hooks/useMedia'
import { FileView, type ViewerFile } from '@/panels/files/FileView'
import { viewerFor, type FileViewerEntry } from '@/panels/files/file-viewers'
import { bytesLabel } from '@/panels/resources/format'

const isMedia = (meta: FileMeta) => meta.kind === 'image' || meta.kind === 'audio' || meta.kind === 'video'

/** A file that is not text: its viewer, the browser's own player, else a download. */
export function Preview({
  meta,
  viewer,
  file,
}: {
  meta: FileMeta
  viewer: FileViewerEntry | undefined
  file: ViewerFile
}) {
  const narrow = useNarrow()
  if (viewer !== undefined) {
    return <FileView viewer={viewer} file={file} text={null} />
  }
  if (isMedia(meta)) {
    return <MediaFile key={file.url} meta={meta} url={file.url} download={file.download} />
  }
  return (
    <NoPreview
      reason={
        viewerFor({ ...meta, size: 0 }, narrow) === undefined ? 'This file has no preview.' : 'Too large to show here.'
      }
      meta={meta}
      download={file.download}
    />
  )
}

function NoPreview({ reason, meta, download }: { reason: string; meta: FileMeta; download: string }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
      <p>
        {reason} {bytesLabel(meta.size)}.
      </p>
      <Button variant="outline" size="sm" asChild>
        <a href={download} download={meta.name}>
          <Download />
          Download
        </a>
      </Button>
    </div>
  )
}

/** An image, audio or video file in the browser's own player, with a download when it cannot play. */
function MediaFile({ meta, url, download }: { meta: FileMeta; url: string; download: string }) {
  const { kind } = meta
  const [failed, setFailed] = useState(false)
  const fail = () => {
    setFailed(true)
  }
  if (failed) {
    const reason = kind === 'image' ? 'This browser cannot show this image.' : 'This browser cannot play this file.'
    return <NoPreview reason={reason} meta={meta} download={download} />
  }
  if (kind === 'audio') {
    return (
      <div className="p-4">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- files from disk come with no caption track */}
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={`Audio ${meta.name}`}
          className="w-full"
          onError={fail}
        />
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- files from disk come with no caption track */}
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={`Video ${meta.name}`}
          className="block max-h-[70vh] max-w-full"
          onError={fail}
        />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <img src={url} alt={meta.name} className="mx-auto block h-auto max-w-full bg-media-backdrop" onError={fail} />
    </div>
  )
}

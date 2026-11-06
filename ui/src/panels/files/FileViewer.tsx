import { FILE_TEXT_MAX, isTextKind, kindByName, type FileMeta } from '@seti/shared'
import { ArrowLeft, Download } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/time'
import { FileImages } from '@/panels/files/FileImages'
import type { ViewerFile } from '@/panels/files/FileView'
import { ModOffNote } from '@/panels/files/ModOffNote'
import { ShareButton } from '@/panels/files/ShareDialog'
import { TextFile } from '@/panels/files/TextFile'
import { Preview } from '@/panels/files/file-previews'
import { useFileViewer } from '@/panels/files/file-viewers'
import { filesLinkUrl, filesPath, nameOf, rawUrl, type FileTarget } from '@/panels/files/files-api'
import { useFileWatch } from '@/panels/files/useFileWatch'
import { ViewerActions } from '@/panels/files/viewer-actions'
import { bytesLabel } from '@/panels/resources/format'

export interface OpenFile {
  target: FileTarget
  /** Not on disk yet: the user is writing a new text file. */
  creating: boolean
  /** The line to show first, from a text search. */
  line?: number | undefined
}

interface FileViewerProps {
  taskId: string
  file: OpenFile
  writable: boolean
  dotfiles: boolean
  onBack: () => void
  onCreated: () => void
}

/** Shown in the text view and editor rather than as a preview or a download. */
const editable = (meta: FileMeta) => isTextKind(meta.kind) && meta.size <= FILE_TEXT_MAX

/** The media type a file is served as, without its charset. */
const typeOf = (meta: FileMeta) => meta.content_type.split(';')[0] ?? meta.content_type

function ViewerHeader({
  taskId,
  target,
  meta,
  creating,
  download,
  link,
  actionsRef,
  onBack,
}: {
  taskId: string
  target: FileTarget
  meta: FileMeta | null
  creating: boolean
  download: string
  /** The file's Files deep link, which Copy link copies. */
  link: string
  /** Receives the spot where the open file puts its own actions, such as Edit and Save. */
  actionsRef: (element: HTMLElement | null) => void
  onBack: () => void
}) {
  const detail = meta === null ? null : `${bytesLabel(meta.size)}, ${typeOf(meta)}, changed ${relativeTime(meta.mtime)}`
  return (
    <div data-testid="viewer-header" className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Hint text="Back to the folder">
        <Button variant="ghost" size="icon-sm" aria-label="Back to the folder" onClick={onBack}>
          <ArrowLeft />
        </Button>
      </Hint>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={target.path}>
          {nameOf(target.path)}
        </div>
        <div className="truncate text-2xs text-muted-foreground">{detail ?? (creating ? 'New file' : '')}</div>
      </div>
      {meta !== null && <CopyIconButton text={link} label="Copy link" variant="outline" />}
      <div ref={actionsRef} className="flex shrink-0 items-center gap-1.5 empty:hidden" />
      {meta !== null && (
        <Hint text={`Download ${meta.name}`}>
          <Button variant="outline" size="icon-sm" asChild>
            <a href={download} download={meta.name} aria-label={`Download ${meta.name}`}>
              <Download />
            </a>
          </Button>
        </Hint>
      )}
      {meta !== null && <ShareButton target={{ taskId, root: target.root, path: target.path, name: meta.name }} />}
    </div>
  )
}

function useMeta(taskId: string, target: FileTarget, dotfiles: boolean, creating: boolean) {
  const [meta, setMeta] = useState<FileMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => {
    setVersion((n) => n + 1)
  }, [])

  useEffect(() => {
    if (creating) {
      return undefined
    }
    let live = true
    apiGet<FileMeta>(filesPath(taskId, 'stat', { root: target.root, path: target.path, dotfiles })).then(
      (next) => {
        if (live) {
          setMeta(next)
          setError(null)
        }
      },
      (e: unknown) => {
        if (live) {
          setError(errorText(e))
        }
      },
    )
    return () => {
      live = false
    }
  }, [taskId, target.root, target.path, dotfiles, creating, version])

  const preview = meta !== null && !editable(meta)
  useFileWatch(preview ? { taskId, root: target.root, path: target.path, dotfiles } : null, (stamp) => {
    if (stamp?.exists === true && stamp.mtime !== (meta?.mtime ?? null)) {
      reload()
    }
  })
  return { meta, error, reload }
}

/** The open file as viewers get it, from its stat once loaded and from its name before. */
function viewerFileOf(
  target: FileTarget,
  meta: FileMeta | null,
  line: number | undefined,
  raw: (download: boolean, preview?: boolean) => string,
): ViewerFile {
  return {
    name: nameOf(target.path),
    kind: meta?.kind ?? kindByName(target.path) ?? 'text',
    size: meta?.size ?? 0,
    mtime: meta?.mtime ?? '',
    url: raw(false),
    download: raw(true),
    page: raw(false, true),
    line: line ?? null,
  }
}

/** One open file: its name and download, then a view that suits its kind. */
export function FileViewer({ taskId, file, writable, dotfiles, onBack, onCreated }: FileViewerProps) {
  const { target, creating } = file
  const [created] = useState(creating)
  const { meta, error, reload } = useMeta(taskId, target, dotfiles, creating)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const raw = (download: boolean, preview = false) =>
    rawUrl(taskId, target, { dotfiles, download, preview, version: meta?.mtime })
  const shown = viewerFileOf(target, meta, file.line, raw)
  const { name, kind } = shown
  const viewer = useFileViewer(shown)
  const showText = created || (meta !== null && editable(meta))
  let body = <p className="p-4 text-sm text-muted-foreground">Loading...</p>
  if (error !== null) {
    body = <p className="p-4 text-sm text-destructive">{error}</p>
  } else if (showText) {
    body = (
      <FileImages taskId={taskId} target={target} dotfiles={dotfiles}>
        <TextFile
          taskId={taskId}
          target={target}
          viewer={viewer}
          file={shown}
          markdown={kind === 'markdown'}
          creating={creating}
          writable={writable && (creating || meta?.writable === true)}
          dotfiles={dotfiles}
          actions={actions}
          onChanged={() => {
            reload()
            if (creating) {
              onCreated()
            }
          }}
        />
      </FileImages>
    )
  } else if (meta !== null) {
    body = <Preview meta={{ ...meta, kind }} viewer={viewer} file={shown} />
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`File ${target.path}`} role="region">
      <ViewerHeader
        taskId={taskId}
        target={target}
        meta={meta}
        creating={creating}
        download={raw(true)}
        link={filesLinkUrl(taskId, { root: target.root, path: target.path, type: 'file' })}
        actionsRef={setActions}
        onBack={onBack}
      />
      {meta !== null && viewer === undefined && <ModOffNote file={{ name, kind }} />}
      <ViewerActions.Provider value={actions}>{body}</ViewerActions.Provider>
    </div>
  )
}

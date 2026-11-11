import type { FileConflict, FileMeta, FileStamp, FileText } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText, RequestError } from '@/api'
import { useConfirm } from '@/components/ui/confirm-context'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { ConflictBanner } from '@/panels/files/ConflictBanner'
import { EditActions, type SourceToggle } from '@/panels/files/EditActions'
import type { ViewerFile } from '@/panels/files/FileView'
import { TextBody } from '@/panels/files/TextBody'
import type { FileViewerEntry } from '@/panels/files/file-viewers'
import { filesPath, type FileTarget } from '@/panels/files/files-api'
import { FileFindBar } from '@/panels/files/find/FileFindBar'
import { useTextFind } from '@/panels/files/find/useTextFind'
import { useFileWatch } from '@/panels/files/useFileWatch'

/** The file on disk when a save found it changed, or null for any other failure. */
const conflictOf = (e: unknown): FileStamp | null => {
  if (!(e instanceof RequestError) || e.status !== 409) {
    return null
  }
  const body = e.body as Partial<FileConflict> | null
  return body?.current ?? null
}

/** What the editor saves against: the text it loaded and its hash, null for a file not made yet. */
interface Base {
  text: string
  hash: string | null
}

interface TextFileProps {
  taskId: string
  target: FileTarget
  /** The viewer that shows the text, or undefined for Markdown or plain text. */
  viewer: FileViewerEntry | undefined
  /** The file as viewers get it, with the line to scroll to and mark in the plain view. */
  file: ViewerFile
  markdown: boolean
  /** A file the user is creating, which does not exist yet. */
  creating: boolean
  writable: boolean
  dotfiles: boolean
  /** The viewer header's spot for Edit, Save and the Source toggle. */
  actions: HTMLElement | null
  /** The file on disk changed or was saved, so its size and time are stale. */
  onChanged: () => void
}

/**
 * A viewer can offer the file's text instead, shown first when a search opened it at a line;
 * the viewer to show, undefined while Source is on, and the toggle.
 */
function useSourceToggle(
  viewer: FileViewerEntry | undefined,
  atLine: boolean,
): { viewer: FileViewerEntry | undefined; toggle: SourceToggle | null } {
  const [pressed, setPressed] = useState(atLine)
  if (viewer?.source !== true) {
    return { viewer, toggle: null }
  }
  return { viewer: pressed ? undefined : viewer, toggle: { pressed, onChange: setPressed } }
}

/** Markdown or plain text, rendered or monospace, with an editor that saves against its base. */
export function TextFile(props: TextFileProps) {
  const { taskId, target, viewer, file, markdown, creating, writable, dotfiles, actions, onChanged } = props
  const confirm = useConfirm()
  const [base, setBase] = useState<Base | null>(creating ? { text: '', hash: null } : null)
  const [draft, setDraft] = useState<string | null>(creating ? '' : null)
  const [conflict, setConflict] = useState<FileStamp | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = useSourceToggle(viewer, file.line !== null)
  const dirty = draft !== null && draft !== base?.text
  useLeaveGuard(dirty)
  const editing = draft !== null
  const { find, readable, editorFind, rootRef, viewRef, line } = useTextFind({
    editing,
    viewer: shown.viewer,
    markdown,
    openedAt: file.line,
  })

  const fetchText = useCallback(
    async () => apiGet<FileText>(filesPath(taskId, 'text', { root: target.root, path: target.path, dotfiles })),
    [taskId, target.root, target.path, dotfiles],
  )

  useEffect(() => {
    if (creating) {
      return undefined
    }
    let live = true
    fetchText().then(
      (loaded) => {
        if (live) {
          setBase({ text: loaded.text, hash: loaded.hash })
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
  }, [creating, fetchText])

  const reload = async (keepEditing: boolean) => {
    try {
      const loaded = await fetchText()
      setBase({ text: loaded.text, hash: loaded.hash })
      setDraft(keepEditing ? loaded.text : null)
      setConflict(null)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const loadedHash = base?.hash ?? null
  const watched = loadedHash === null ? null : { taskId, root: target.root, path: target.path, dotfiles }
  useFileWatch(watched, (stamp) => {
    if (stamp === null || base === null || stamp.hash === base.hash) {
      return
    }
    if (dirty || !stamp.exists) {
      setConflict(stamp)
      return
    }
    void reload(draft !== null)
  })

  const save = async (text: string, baseHash: string | null) => {
    setSaving(true)
    try {
      const meta = await apiPut<FileMeta>(`/tasks/${taskId}/files/text`, {
        root: target.root,
        path: target.path,
        text,
        base_hash: baseHash,
        dotfiles,
      })
      setBase({ text, hash: meta.hash })
      setConflict(null)
      onChanged()
      toast.success(`Saved ${target.path}`)
    } catch (e) {
      const current = conflictOf(e)
      if (current === null) {
        toast.error(errorText(e))
      } else {
        setConflict(current)
      }
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = () => {
    if (draft !== null && base !== null && !saving) {
      void save(draft, base.hash)
    }
  }

  const toggleEdit = async (on: boolean) => {
    if (on) {
      setDraft(base?.text ?? '')
      return
    }
    if (dirty && !(await confirm({ message: 'Discard unsaved changes?', confirmLabel: 'Discard' }))) {
      return
    }
    setDraft(null)
    setConflict(null)
  }

  if (error !== null) {
    return <p className="p-4 text-sm text-destructive">{error}</p>
  }
  if (base === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading...</p>
  }
  const current = draft ?? base.text
  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {actions !== null &&
        createPortal(
          <EditActions
            text={current}
            writable={writable}
            editing={editing}
            dirty={dirty}
            saving={saving}
            source={shown.toggle}
            onFind={readable ? find.openFind : null}
            onEdit={(next) => void toggleEdit(next)}
            onSave={saveDraft}
          />,
          actions,
        )}
      {conflict !== null && (
        <ConflictBanner
          stamp={conflict}
          onReload={() => void reload(draft !== null)}
          onOverwrite={() => {
            void save(current, conflict.exists ? conflict.hash : null)
          }}
        />
      )}
      {readable && <FileFindBar find={find} editable={editing} text={current} />}
      <TextBody
        path={target.path}
        text={base.text}
        draft={draft}
        viewer={shown.viewer}
        file={{ ...file, line }}
        markdown={markdown}
        onDraft={setDraft}
        onSave={saveDraft}
        find={editorFind}
        viewRef={viewRef}
      />
    </div>
  )
}

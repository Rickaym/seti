import {
  type FileConflict,
  type FileMeta,
  type FileStamp,
  type FileText,
  languageOfPath,
  type CodeLanguage,
} from '@seti/shared'
import { RefreshCw, TriangleAlert, Upload } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText, RequestError } from '@/api'
import { Hint } from '@/components/Hint'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { cn } from '@/lib/utils'
import { CodeText } from '@/panels/files/CodeText'
import { EditActions, type SourceToggle } from '@/panels/files/EditActions'
import { FileView, type ViewerFile } from '@/panels/files/FileView'
import { MONO, PlainText } from '@/panels/files/PlainText'
import { plainReason, type PlainReason } from '@/panels/files/code-lines'
import type { FileViewerEntry } from '@/panels/files/file-viewers'
import { filesPath, type FileTarget } from '@/panels/files/files-api'
import { useFileWatch } from '@/panels/files/useFileWatch'

const Markdown = lazy(async () => import('@/components/Markdown').then((m) => ({ default: m.Markdown })))

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

const conflictOf = (e: unknown): FileStamp | null => {
  if (!(e instanceof RequestError) || e.status !== 409) {
    return null
  }
  const body = e.body as Partial<FileConflict> | null
  return body?.current ?? null
}

function ConflictBanner({
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

interface ViewProps {
  text: string
  viewer: FileViewerEntry | undefined
  file: ViewerFile
  markdown: boolean
  /** The language to colour plain text as, or null for prose. */
  language: CodeLanguage | null
}

const PLAIN_NOTES: Record<PlainReason, string> = {
  size: 'Too large to colour; showing plain text.',
  'long-line': 'A line is too long to colour; showing plain text.',
}

/** A note that a file stays plain and why, quiet enough to sit above its text. */
function PlainNote({ reason }: { reason: PlainReason }) {
  return (
    <p className="shrink-0 border-b border-border px-4 py-1 text-2xs text-muted-foreground">{PLAIN_NOTES[reason]}</p>
  )
}

function View({ text, viewer, file, markdown, language }: ViewProps) {
  if (viewer !== undefined) {
    return <FileView viewer={viewer} file={file} text={text} />
  }
  const line = file.line ?? undefined
  if (!markdown && language !== null) {
    const plain = plainReason(text)
    return plain === null ? (
      <CodeText text={text} language={language} line={line} />
    ) : (
      <>
        <PlainNote reason={plain} />
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <PlainText text={text} line={line} />
        </div>
      </>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      {markdown ? (
        <Suspense fallback={<pre className={cn(MONO, 'whitespace-pre-wrap')}>{text}</pre>}>
          <Markdown text={text} />
        </Suspense>
      ) : (
        <PlainText text={text} line={line} />
      )}
    </div>
  )
}

/** The file as its viewer shows it, or the editor; some viewers show the saved file under it. */
function Body({
  path,
  draft,
  onDraft,
  onSave,
  ...view
}: Omit<ViewProps, 'language'> & {
  path: string
  draft: string | null
  onDraft: (draft: string) => void
  onSave: () => void
}) {
  const { viewer } = view
  const language = languageOfPath(path)
  if (draft === null) {
    return <View {...view} language={language} />
  }
  const plain = plainReason(draft)
  const fits = plain === null
  const editor = (
    <>
      {language !== null && plain !== null && <PlainNote reason={plain} />}
      <CodeEditor
        label={`Edit ${path}`}
        value={draft}
        language={fits ? language : null}
        spellCheck={view.markdown}
        focusOnMount
        onChange={onDraft}
        onSave={onSave}
        className="min-h-0 flex-1 resize-none border-0 focus-within:ring-0 md:text-xs"
      />
    </>
  )
  if (viewer?.whileEditing !== true) {
    return editor
  }
  const region = `Saved ${viewer.title.toLowerCase()}`
  return (
    <>
      {editor}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border" aria-label={region} role="region">
        <FileView viewer={viewer} file={view.file} text={view.text} editing />
      </div>
    </>
  )
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

  const toggleEdit = async (editing: boolean) => {
    if (editing) {
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {actions !== null &&
        createPortal(
          <EditActions
            writable={writable}
            editing={draft !== null}
            dirty={dirty}
            saving={saving}
            source={shown.toggle}
            onEdit={(editing) => void toggleEdit(editing)}
            onSave={saveDraft}
          />,
          actions,
        )}
      {conflict !== null && (
        <ConflictBanner
          stamp={conflict}
          onReload={() => void reload(draft !== null)}
          onOverwrite={() => {
            void save(draft ?? base.text, conflict.exists ? conflict.hash : null)
          }}
        />
      )}
      <Body
        path={target.path}
        text={base.text}
        draft={draft}
        viewer={shown.viewer}
        file={file}
        markdown={markdown}
        onDraft={setDraft}
        onSave={saveDraft}
      />
    </div>
  )
}

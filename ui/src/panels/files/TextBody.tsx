import { languageOfPath, type CodeLanguage } from '@seti/shared'
import { lazy, Suspense } from 'react'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import type { EditorFind } from '@/components/code-editor/editor-find'
import { cn } from '@/lib/utils'
import { CodeText } from '@/panels/files/CodeText'
import { FileView, type ViewerFile } from '@/panels/files/FileView'
import { MONO, PlainText } from '@/panels/files/PlainText'
import { plainReason, type PlainReason } from '@/panels/files/code-lines'
import type { FileViewerEntry } from '@/panels/files/file-viewers'

const Markdown = lazy(async () => import('@/components/Markdown').then((m) => ({ default: m.Markdown })))

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
    <p data-no-find="" className="shrink-0 border-b border-border px-4 py-1 text-2xs text-muted-foreground">
      {PLAIN_NOTES[reason]}
    </p>
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
export function TextBody({
  path,
  draft,
  onDraft,
  onSave,
  find,
  viewRef,
  ...view
}: Omit<ViewProps, 'language'> & {
  path: string
  draft: string | null
  onDraft: (draft: string) => void
  onSave: () => void
  /** The find bar the editor serves while editing. */
  find: EditorFind
  /** Receives the view's box, which find searches and which takes focus on a click. */
  viewRef: (element: HTMLElement | null) => void
}) {
  const { viewer } = view
  const language = languageOfPath(path)
  if (draft === null) {
    return (
      <div ref={viewRef} tabIndex={-1} data-file-view="" className="flex min-h-0 flex-1 flex-col outline-none">
        <View {...view} language={language} />
      </div>
    )
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
        find={find}
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

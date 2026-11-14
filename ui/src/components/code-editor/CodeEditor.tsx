import type { CodeLanguage } from '@seti/shared'
import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { TextFindBar } from '@/components/find/FindBar'
import { FieldFindButton } from '@/components/find/FindButton'
import { PlainTextarea } from '@/components/find/FindableTextarea'
import { useEditorFind } from '@/components/find/useEditorFind'
import { useFind } from '@/components/find/useFind'
import { useFindKeys } from '@/components/find/useFindKeys'
import { useCoarsePointer } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import type { EditorFind } from './editor-find'
import type { Caret } from './sync'

const CodeMirrorEditor = lazy(async () => import('./CodeMirrorEditor').then((m) => ({ default: m.CodeMirrorEditor })))

/** The textarea's frame, so the editor that replaces it keeps its size and focus ring. */
const FRAME =
  'flex w-full resize-y flex-col overflow-hidden rounded-none border border-input bg-transparent font-mono text-xs leading-relaxed [font-variant-ligatures:none] focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 pointer-coarse:text-base dark:bg-input/30'

const isSaveKey = (e: { ctrlKey: boolean; metaKey: boolean; key: string }) =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** The accessible name of the text field. */
  label: string
  /** Sizes the field, such as its minimum height. */
  className?: string
  /** The language to colour, or null for plain text. */
  language?: CodeLanguage | null
  spellCheck?: boolean
  /** Takes focus when it appears, as when the user asked to edit. */
  focusOnMount?: boolean
  /** Ctrl+S or Cmd+S in the field. */
  onSave?: () => void
  /** The find bar the screen shows for this editor; without it the editor shows its own. */
  find?: EditorFind
}

/**
 * A code editor with highlighting, line numbers and bracket matching. Ctrl+F finds, Ctrl+H
 * replaces and Ctrl+G goes to a line in it, with its own find bar unless the screen serves one
 * through `find`.
 */
export function CodeEditor(props: CodeEditorProps) {
  return props.find === undefined ? <FindableCodeEditor {...props} /> : <LazyCodeEditor {...props} />
}

/** The editor with its own find bar, and a Find button in its corner on a touch screen. */
function FindableCodeEditor(props: CodeEditorProps) {
  const find = useFind()
  const { editorFind } = useEditorFind(find)
  const touch = useCoarsePointer()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useFindKeys(root, find, { find: true, replace: true, line: true })
  return (
    <div ref={setRoot} className="group/find flex min-w-0 flex-col">
      <TextFindBar find={find} editable text={props.value} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LazyCodeEditor {...props} find={editorFind} />
        {touch && find.mode === null && <FieldFindButton find={find} />}
      </div>
    </div>
  )
}

/** CodeMirror loads on first use; a plain textarea with the same value takes typing until then. */
function LazyCodeEditor({
  value,
  onChange,
  label,
  className,
  language = 'javascript',
  spellCheck = false,
  focusOnMount = false,
  onSave,
  find,
}: CodeEditorProps) {
  const handoff = useRef<Caret | null>(null)
  const keepCaret = useCallback(
    (field: HTMLTextAreaElement | null) => {
      if (focusOnMount) {
        field?.focus()
      }
      return () => {
        if (field !== null && document.activeElement === field) {
          const backward = field.selectionDirection === 'backward'
          handoff.current = {
            anchor: backward ? field.selectionEnd : field.selectionStart,
            head: backward ? field.selectionStart : field.selectionEnd,
          }
        }
      }
    },
    [focusOnMount],
  )
  const takeCaret = useCallback(() => {
    const caret = handoff.current
    handoff.current = null
    return caret
  }, [])
  return (
    <Suspense
      fallback={
        <PlainTextarea
          ref={keepCaret}
          aria-label={label}
          spellCheck={spellCheck}
          className={cn('font-mono leading-relaxed [font-variant-ligatures:none]', className)}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
          }}
          onKeyDown={(e) => {
            if (onSave !== undefined && isSaveKey(e)) {
              e.preventDefault()
              onSave()
            }
          }}
        />
      }
    >
      <CodeMirrorEditor
        value={value}
        onChange={onChange}
        label={label}
        className={cn(FRAME, className)}
        takeCaret={takeCaret}
        language={language}
        spellCheck={spellCheck}
        focusOnMount={focusOnMount}
        onSave={onSave}
        find={find}
      />
    </Suspense>
  )
}

import type { CodeLanguage } from '@seti/shared'
import { lazy, Suspense, useCallback, useRef } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { EditorFind } from './editor-find'
import type { Caret } from './sync'

const CodeMirrorEditor = lazy(async () => import('./CodeMirrorEditor').then((m) => ({ default: m.CodeMirrorEditor })))

/** The textarea's frame, so the editor that replaces it keeps its size and focus ring. */
const FRAME =
  'flex w-full resize-y flex-col overflow-hidden rounded-none border border-input bg-transparent font-mono text-xs leading-relaxed [font-variant-ligatures:none] focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 pointer-coarse:text-base dark:bg-input/30'

const isSaveKey = (e: { ctrlKey: boolean; metaKey: boolean; key: string }) =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'

/**
 * A code editor with highlighting, line numbers and bracket matching. CodeMirror loads on first
 * use; until then a plain textarea with the same value takes the typing.
 */
export function CodeEditor({
  value,
  onChange,
  label,
  className,
  language = 'javascript',
  spellCheck = false,
  focusOnMount = false,
  onSave,
  find,
}: {
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
  /** The find bar this editor serves, if any. */
  find?: EditorFind
}) {
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
        <Textarea
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

import { useLayoutEffect, useRef, type ChangeEvent } from 'react'
import { rebaseEdit } from '@/lib/text-rebase'

/** A change made elsewhere mid-composition: the field's text then and the text asked for. */
interface PendingEdit {
  base: string
  next: string
}

/**
 * Binds an uncontrolled textarea to `value`. Typing flows out through `onChange` and is never
 * written back; only changes made elsewhere, such as clearing after a send, reach the field.
 * Those wait while a keyboard composes a word: text rewritten under an IME composition
 * desyncs the keyboard, which then inserts its stale copy of the text again.
 */
export function useEditorText(value: string, onChange: (value: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null)
  /** The value the parent last heard of or set; null until the field first shows it. */
  const reported = useRef<string | null>(null)
  const composing = useRef(false)
  const pending = useRef<PendingEdit | null>(null)
  const report = useRef(onChange)

  const emit = (text: string) => {
    reported.current = text
    report.current(text)
  }

  useLayoutEffect(() => {
    report.current = onChange
    const field = ref.current
    if (field === null || value === reported.current) {
      return
    }
    reported.current = value
    if (composing.current) {
      pending.current = { base: field.value, next: value }
    } else if (field.value !== value) {
      field.value = value
    }
  })

  const endComposition = () => {
    composing.current = false
    const field = ref.current
    const edit = pending.current
    pending.current = null
    if (field === null || edit === null) {
      return
    }
    const text = rebaseEdit(edit.base, edit.next, field.value)
    if (field.value !== text) {
      field.value = text
    }
    if (text !== reported.current) {
      emit(text)
    }
  }

  return {
    ref,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      const edit = pending.current
      const text = e.target.value
      emit(edit === null ? text : rebaseEdit(edit.base, edit.next, text))
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: endComposition,
    /** Blur ends a composition too, in case the browser sends no compositionend. */
    onBlur: endComposition,
  }
}

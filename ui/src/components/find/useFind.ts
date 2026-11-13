import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import type { FindCount, FindQuery, FindTarget } from '@/lib/text-find'

/** What the find bar shows: find, find with replace, or go to line. */
type FindMode = 'find' | 'replace' | 'line'

export interface FindState {
  mode: FindMode | null
  /** The query to mark, or null while find is closed or going to a line. */
  query: FindQuery | null
  text: string
  setText: (text: string) => void
  caseSensitive: boolean
  setCaseSensitive: (caseSensitive: boolean) => void
  replacement: string
  setReplacement: (replacement: string) => void
  count: FindCount | null
  setCount: (count: FindCount | null) => void
  /** Changes each time find is asked to open, so the bar focuses its field again. */
  focusRequest: number
  target: RefObject<FindTarget | null>
  open: (mode: FindMode) => void
  /** Opens plain find, as the header's Find button does. */
  openFind: () => void
  close: () => void
}

/** Find, replace and go to line in one text, with the editor, view or box behind `target`. */
export function useFind(): FindState {
  const [mode, setMode] = useState<FindMode | null>(null)
  const [text, setText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [count, setCount] = useState<FindCount | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const target = useRef<FindTarget | null>(null)

  const open = useCallback((next: FindMode) => {
    const selected = next === 'line' ? '' : (target.current?.selection() ?? '')
    if (selected !== '' && !selected.includes('\n')) {
      setText(selected)
    }
    setMode(next)
    setFocusRequest((value) => value + 1)
  }, [])

  const openFind = useCallback(() => {
    open('find')
  }, [open])

  const close = useCallback(() => {
    setMode(null)
    target.current?.focus()
  }, [])

  const query = useMemo(
    () => (mode === 'find' || mode === 'replace' ? { text, caseSensitive } : null),
    [mode, text, caseSensitive],
  )
  return {
    mode,
    query,
    text,
    setText,
    caseSensitive,
    setCaseSensitive,
    replacement,
    setReplacement,
    count,
    setCount,
    focusRequest,
    target,
    open,
    openFind,
    close,
  }
}

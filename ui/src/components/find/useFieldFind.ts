import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FindState } from '@/components/find/useFind'
import { replaceRange } from '@/lib/text-edit'
import type { FindCount, FindQuery, FindTarget } from '@/lib/text-find'
import { findMatches, matchFrom, replaceAllEdit, replaceOneEdit, stepMatch, type TextMatch } from '@/lib/text-matches'

/** What a message box's marks show: its text, every match in it and the one find stands on. */
export interface FieldMatches {
  text: string
  matches: TextMatch[]
  index: number
  /** More matches lie past the counted ones. */
  capped: boolean
  /** Changes each time find moves to a match, so the marks scroll it into view. */
  reveal: number
}

interface Live {
  query: FindQuery | null
  editable: boolean
  setCount: (count: FindCount | null) => void
}

/** Find and replace over one textarea; `publish` hears where find stands after each change. */
function fieldFinder(
  field: () => HTMLTextAreaElement | null,
  live: () => Live,
  publish: (found: FieldMatches) => void,
) {
  let found: FieldMatches | null = null
  /** Where the next search starts: the caret at open, then the match shown or the last edit. */
  let anchor = 0

  /** Shows where find stands; `reveal` selects the match and has the marks scroll to it. */
  const land = (el: HTMLTextAreaElement, next: Omit<FieldMatches, 'reveal'>, reveal: boolean) => {
    const match = next.matches[next.index]
    if (reveal && match !== undefined) {
      el.setSelectionRange(match.from, match.to)
      anchor = match.from
    }
    const was = found?.reveal ?? 0
    found = { ...next, reveal: reveal ? was + 1 : was }
    publish(found)
    live().setCount({ index: next.index, total: next.matches.length, capped: next.capped })
  }

  /** Searches the box again; `reveal` selects the match found and scrolls to it. */
  const show = (reveal: boolean) => {
    const el = field()
    const { query } = live()
    if (el === null || query === null) {
      return
    }
    const { matches, capped } = findMatches(el.value, query)
    land(el, { text: el.value, matches, capped, index: matchFrom(matches, anchor) }, reveal)
  }

  const step = (by: 1 | -1) => {
    const el = field()
    if (el === null || found === null || found.matches.length === 0) {
      return
    }
    land(el, { ...found, index: stepMatch(found.index, found.matches.length, by) }, true)
  }

  const edit = (from: number, to: number, insert: string) => {
    const el = field()
    if (el === null || !live().editable) {
      return
    }
    replaceRange(el, from, to, insert)
    anchor = from + insert.length
    show(true)
  }

  const target: FindTarget = {
    next: () => {
      step(1)
    },
    previous: () => {
      step(-1)
    },
    selection: () => {
      const el = field()
      return el === null ? '' : el.value.slice(el.selectionStart, el.selectionEnd)
    },
    focus: () => {
      field()?.focus({ preventScroll: true })
    },
    replace: (replacement) => {
      const match = found?.matches[found.index]
      if (match !== undefined) {
        const one = replaceOneEdit(match, replacement)
        edit(one.from, one.to, one.insert)
      }
    },
    replaceAll: (replacement) => {
      const { query } = live()
      const text = field()?.value ?? null
      const all = text === null || query === null ? null : replaceAllEdit(text, query, replacement)
      if (all !== null) {
        edit(all.from, all.to, all.insert)
      }
    },
  }
  return {
    target,
    show,
    /** Find opened: search from the caret. */
    start: () => {
      anchor = field()?.selectionStart ?? 0
      found = null
    },
  }
}

/**
 * Find and replace in a message box: serves `find` its target, selects the match it stands on
 * and keeps the count as the text changes. Returns what the marks show while find is open.
 */
export function useFieldFind(
  fieldRef: RefObject<HTMLTextAreaElement | null>,
  find: FindState,
  value: string,
  editable: boolean,
): FieldMatches | null {
  const { query, target: targetRef, setCount } = find
  const [found, setFound] = useState<FieldMatches | null>(null)
  const liveRef = useRef<Live>({ query, editable, setCount })
  useLayoutEffect(() => {
    liveRef.current = { query, editable, setCount }
  })
  const finderRef = useRef<Finder | null>(null)
  /** Made on first use in an effect, since it reads the refs it is given. */
  const finder = useCallback(
    () =>
      (finderRef.current ??= fieldFinder(
        () => fieldRef.current,
        () => liveRef.current,
        setFound,
      )),
    [fieldRef],
  )

  useEffect(() => {
    const own = finder().target
    targetRef.current = own
    return () => {
      if (targetRef.current === own) {
        targetRef.current = null
      }
    }
  }, [finder, targetRef])

  const opened = query !== null
  useEffect(() => {
    if (!opened) {
      return undefined
    }
    finder().start()
    return () => {
      setCount(null)
    }
  }, [opened, finder, setCount])
  useEffect(() => {
    finder().show(true)
  }, [query, finder])
  useEffect(() => {
    finder().show(false)
  }, [value, finder])

  return opened ? found : null
}

type Finder = ReturnType<typeof fieldFinder>

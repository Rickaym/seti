import { useCallback, useEffect, useRef } from 'react'
import { showFindRanges } from '@/lib/find-highlights'
import type { FindCount, FindQuery, FindTarget } from '@/lib/text-find'
import { findInView, firstShown, scrollToRange, type ViewMatches } from '@/panels/files/find/dom-find'

interface Found {
  owner: symbol
  matches: ViewMatches
  index: number
}

/** The first match at or after `offset` in the view's text, or the first one. */
const atOrAfter = (starts: readonly number[], offset: number) =>
  Math.max(
    0,
    starts.findIndex((at) => at >= offset),
  )

function mark(found: Found, onCount: (count: FindCount) => void): void {
  const { ranges, capped } = found.matches
  const current = ranges[found.index]
  showFindRanges(found.owner, {
    all: ranges.filter((_, n) => n !== found.index),
    current: current === undefined ? [] : [current],
  })
  onCount({ index: found.index, total: ranges.length, capped })
}

/**
 * Find in a read-only view's rendered text: marks every match in `root`, keeps them as the view
 * colours or reloads its text, and steps through them.
 */
export function useViewFind(
  root: HTMLElement | null,
  query: FindQuery | null,
  onCount: (count: FindCount | null) => void,
): Pick<FindTarget, 'next' | 'previous' | 'selection'> {
  const found = useRef<Found | null>(null)

  useEffect(() => {
    const element = root
    if (element === null || query === null || query.text === '') {
      return undefined
    }
    const owner = Symbol('file-find')
    let frame: number | null = null
    const paint = () => {
      frame = null
      const matches = findInView(element, query)
      const was = found.current?.owner === owner ? found.current : null
      const first = was === null
      const index = first
        ? firstShown(matches.ranges, element)
        : atOrAfter(matches.starts, was.matches.starts[was.index] ?? 0)
      const next = { owner, matches, index: matches.ranges.length === 0 ? -1 : index }
      found.current = next
      mark(next, onCount)
      const range = matches.ranges[next.index]
      if (first && range !== undefined) {
        scrollToRange(range, element)
      }
    }
    paint()
    const observer = new MutationObserver(() => {
      frame ??= requestAnimationFrame(paint)
    })
    observer.observe(element, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      found.current = null
      showFindRanges(owner, null)
      onCount(null)
    }
  }, [root, query, onCount])

  const step = useCallback(
    (by: 1 | -1) => {
      const now = found.current
      const element = root
      const total = now?.matches.ranges.length ?? 0
      if (now === null || element === null || total === 0) {
        return
      }
      now.index = now.index < 0 && by < 0 ? total - 1 : (now.index + by + total) % total
      mark(now, onCount)
      const range = now.matches.ranges[now.index]
      if (range !== undefined) {
        scrollToRange(range, element)
      }
    },
    [root, onCount],
  )

  const selection = useCallback(() => {
    const selected = window.getSelection()
    const anchor = selected?.anchorNode ?? null
    return anchor !== null && root?.contains(anchor) === true ? (selected?.toString() ?? '') : ''
  }, [root])

  return {
    next: useCallback(() => {
      step(1)
    }, [step]),
    previous: useCallback(() => {
      step(-1)
    }, [step]),
    selection,
  }
}

import type { SearchMode } from '@seti/shared'
import { createContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { showFindRanges, type FindRanges } from '@/lib/find-highlights'

/** What find marks in a chat's rows: the query's matches, and the message it stepped to. */
export interface FindMarks {
  query: string
  mode: SearchMode
  /** Find skips tool calls and output, so only text marked as a message lights up. */
  messagesOnly: boolean
  /** The message of the current hit, or null while there is none. */
  focusId: number | null
  /** Changes on every step, so stepping back to the same message scrolls to it again. */
  step: number
}

/** The message find stepped to, so collapsed groups holding it open themselves. */
export const FindFocusContext = createContext<number | null>(null)

const CURRENT_ATTR = 'data-find-current'
/** Marks the text of a message, as opposed to tool calls, their output and notes around it. */
const FIND_TEXT_ATTR = 'data-find-text'
/** Enough to light every match on screen; a common two-letter query stops here. */
const MAX_RANGES = 2000

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const WORD = /[\p{L}\p{N}_]+/gu

/** A pattern for the query's matches in rendered text, as the server matched them. */
export function findPattern(query: string, mode: SearchMode): RegExp | null {
  const q = query.trim()
  if (q === '') {
    return null
  }
  if (mode === 'text') {
    return new RegExp(q.split(/\s+/u).map(escapeRegExp).join('\\s+'), 'giu')
  }
  const words = q.match(WORD)
  if (words === null) {
    return null
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
}

/** The rendered element of a message: its own row, or the tool call its result shows in. */
function messageElement(root: ParentNode, id: number): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`[data-message-id="${String(id)}"]`) ??
    root.querySelector<HTMLElement>(`[data-result-row="${String(id)}"]`)
  )
}

function markRanges(root: HTMLElement, pattern: RegExp, messagesOnly: boolean): FindRanges {
  const ranges: FindRanges = { all: [], current: [] }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let count = 0
  for (let node = walker.nextNode(); node !== null && count < MAX_RANGES; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.data.trim() === '') {
      continue
    }
    if (messagesOnly && (node.parentElement?.closest(`[${FIND_TEXT_ATTR}]`) ?? null) === null) {
      continue
    }
    const target = (node.parentElement?.closest(`[${CURRENT_ATTR}]`) ?? null) === null ? ranges.all : ranges.current
    for (const match of node.data.matchAll(pattern)) {
      const range = new Range()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      target.push(range)
      count += 1
    }
  }
  return ranges
}

/** Opens the collapsed tool call a hit sits in when the match is hidden inside it. */
function reveal(element: HTMLElement, pattern: RegExp | null): void {
  const test = pattern === null ? null : new RegExp(pattern.source, 'iu')
  const boxes = element instanceof HTMLDetailsElement ? [element] : [...element.querySelectorAll('details')]
  const box = boxes.find((candidate) => !candidate.open && (test === null || test.test(candidate.textContent)))
  if (box !== undefined) {
    box.open = true
  }
}

/** Lights matches in `root`, rings the current hit and scrolls to it once its row renders. */
export function useFindMarks(
  root: RefObject<HTMLElement | null>,
  marks: FindMarks | null,
  rows: unknown,
  onFocus?: () => void,
): void {
  const scrolled = useRef<string | null>(null)
  const active = marks !== null
  const query = marks?.query ?? ''
  const mode = marks?.mode ?? 'text'
  const messagesOnly = marks?.messagesOnly ?? false
  const focusId = marks?.focusId ?? null
  const step = marks?.step ?? 0

  useLayoutEffect(() => {
    const element = root.current
    if (element === null) {
      return
    }
    for (const old of element.querySelectorAll(`[${CURRENT_ATTR}]`)) {
      old.removeAttribute(CURRENT_ATTR)
    }
    const target = focusId === null ? null : messageElement(element, focusId)
    if (target === null) {
      return
    }
    target.setAttribute(CURRENT_ATTR, '')
    const key = `${String(focusId)}:${String(step)}`
    if (scrolled.current !== key) {
      scrolled.current = key
      if (!messagesOnly) {
        reveal(target, findPattern(query, mode))
      }
      onFocus?.()
      target.scrollIntoView({ block: 'center' })
    }
  }, [root, focusId, step, rows, query, mode, messagesOnly, onFocus])

  useEffect(() => {
    const element = root.current
    const pattern = findPattern(query, mode)
    if (element === null || pattern === null || !active) {
      return
    }
    const owner = Symbol('find')
    let frame: number | null = null
    const paint = () => {
      frame = null
      showFindRanges(owner, markRanges(element, pattern, messagesOnly))
    }
    paint()
    const observer = new MutationObserver(() => {
      frame ??= requestAnimationFrame(paint)
    })
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [CURRENT_ATTR, 'open'],
    })
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      showFindRanges(owner, null)
    }
  }, [root, query, mode, messagesOnly, active])
}

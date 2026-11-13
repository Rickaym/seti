import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FieldMatches } from '@/components/find/useFieldFind'
import { showFindRanges } from '@/lib/find-highlights'

/** What sets where a textarea's text wraps and how tall its lines are. */
const COPIED = [
  'box-sizing',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-kerning',
  'font-variant-ligatures',
  'font-feature-settings',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-indent',
  'text-transform',
  'text-align',
  'tab-size',
  'direction',
  'white-space',
  'word-break',
  'overflow-wrap',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-bottom-width',
  'border-left-width',
  'border-right-width',
  'border-style',
] as const

const px = (value: number) => `${String(value)}px`

/** Lays the copy exactly over the box, with room for the box's scroll bar so lines wrap alike. */
function place(copy: HTMLElement, field: HTMLTextAreaElement): void {
  const computed = getComputedStyle(field)
  for (const name of COPIED) {
    copy.style.setProperty(name, computed.getPropertyValue(name))
  }
  const sides = parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth)
  const scrollBar = field.offsetWidth - field.clientWidth - sides
  copy.style.setProperty('padding-right', px(parseFloat(computed.paddingRight) + scrollBar))
  copy.style.setProperty('left', px(field.offsetLeft))
  copy.style.setProperty('top', px(field.offsetTop))
  copy.style.setProperty('width', px(field.offsetWidth))
  copy.style.setProperty('height', px(field.offsetHeight))
  copy.scrollTo({ top: field.scrollTop })
}

function rangeOf(text: Node, from: number, to: number): Range {
  const range = new Range()
  range.setStart(text, from)
  range.setEnd(text, to)
  return range
}

/** Scrolls the box so `range`, measured in the copy, sits in the middle of it. */
function reveal(copy: HTMLElement, field: HTMLTextAreaElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  const frame = copy.getBoundingClientRect()
  if (rect.top < frame.top || rect.bottom > frame.bottom) {
    field.scrollTo({ top: rect.top - frame.top + copy.scrollTop - field.clientHeight / 2 })
    copy.scrollTo({ top: field.scrollTop })
  }
}

/**
 * Marks every match in a message box. A textarea paints no highlights, so a see-through copy of
 * its text lies over it, wrapped and scrolled alike, and the find highlights paint on the copy.
 */
export function FieldMarks({ field, found }: { field: HTMLTextAreaElement | null; found: FieldMatches | null }) {
  return field === null || found === null ? null : <Marks field={field} found={found} />
}

function Marks({ field, found }: { field: HTMLTextAreaElement; found: FieldMatches }) {
  const copy = useRef<HTMLDivElement>(null)
  const [owner] = useState(() => Symbol('field-find'))
  const [resized, setResized] = useState(0)
  const revealed = useRef<number | null>(null)

  useEffect(() => {
    const element = copy.current
    if (element === null) {
      return undefined
    }
    const onScroll = () => {
      element.scrollTop = field.scrollTop
    }
    const observer = new ResizeObserver(() => {
      setResized((count) => count + 1)
    })
    observer.observe(field)
    field.addEventListener('scroll', onScroll)
    return () => {
      observer.disconnect()
      field.removeEventListener('scroll', onScroll)
    }
  }, [field])

  useLayoutEffect(() => {
    const element = copy.current
    const text = element?.firstChild ?? null
    if (element === null || text === null) {
      return undefined
    }
    place(element, field)
    const length = text.textContent?.length ?? 0
    const ranges = found.matches
      .filter((match) => match.to <= length)
      .map((match) => rangeOf(text, match.from, match.to))
    const current = ranges[found.index]
    showFindRanges(owner, {
      all: ranges.filter((range) => range !== current),
      current: current === undefined ? [] : [current],
    })
    if (current !== undefined && revealed.current !== found.reveal) {
      reveal(element, field, current)
    }
    revealed.current = found.reveal
    return () => {
      showFindRanges(owner, null)
    }
  }, [field, found, owner, resized])

  return (
    <div
      ref={copy}
      aria-hidden="true"
      data-no-find
      data-testid="field-find-marks"
      className="pointer-events-none absolute overflow-hidden border-transparent text-transparent select-none"
    >{`${found.text} `}</div>
  )
}

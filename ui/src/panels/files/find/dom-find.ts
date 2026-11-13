import type { FindQuery } from '@/lib/text-find'
import { MAX_MATCHES, queryPattern } from '@/lib/text-matches'

/** The matches of one query in a view, where each starts in the view's text, and their ranges. */
export interface ViewMatches {
  starts: number[]
  ranges: Range[]
  capped: boolean
}

/** The text nodes a reader sees, so line numbers and other hidden parts never match. */
function shownText(root: HTMLElement): { nodes: Text[]; starts: number[]; text: string } {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement?.closest('[aria-hidden="true"], [data-no-find], script, style') ?? null) === null
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data !== '') {
      nodes.push(node)
      starts.push(text.length)
      text += node.data
    }
  }
  return { nodes, starts, text }
}

/** The index of the node holding `offset`: the last one starting before it, or at it for a start. */
function nodeAt(starts: number[], offset: number, end: boolean): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const start = starts[mid] ?? 0
    if (end ? start < offset : start <= offset) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}

/** Every match in `root`, joining text split across elements such as coloured tokens. */
export function findInView(root: HTMLElement, query: FindQuery): ViewMatches {
  const shown = shownText(root)
  const matches: ViewMatches = { starts: [], ranges: [], capped: false }
  for (const match of shown.text.matchAll(queryPattern(query))) {
    if (matches.ranges.length === MAX_MATCHES) {
      matches.capped = true
      break
    }
    const from = match.index
    const to = from + match[0].length
    const first = nodeAt(shown.starts, from, false)
    const last = nodeAt(shown.starts, to, true)
    const startNode = shown.nodes[first]
    const endNode = shown.nodes[last]
    if (startNode === undefined || endNode === undefined) {
      continue
    }
    const range = new Range()
    range.setStart(startNode, from - (shown.starts[first] ?? 0))
    range.setEnd(endNode, to - (shown.starts[last] ?? 0))
    matches.starts.push(from)
    matches.ranges.push(range)
  }
  return matches
}

/** The first match at or below the top of `root`'s visible area, so find starts where you read. */
export function firstShown(ranges: readonly Range[], root: HTMLElement): number {
  const top = root.getBoundingClientRect().top
  const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top)
  return index < 0 ? 0 : index
}

const SCROLLS = /auto|scroll/u

/** Scrolls every scrolling box from the match up to `root` so the match sits in view. */
export function scrollToRange(range: Range, root: HTMLElement): void {
  for (let box = range.startContainer.parentElement; box !== null; box = box.parentElement) {
    const style = getComputedStyle(box)
    if (SCROLLS.test(`${style.overflowY} ${style.overflowX}`)) {
      const rect = range.getBoundingClientRect()
      const frame = box.getBoundingClientRect()
      if (rect.top < frame.top || rect.bottom > frame.bottom) {
        box.scrollTop += rect.top - frame.top - frame.height / 2
      }
      if (rect.left < frame.left + frame.width / 10 || rect.right > frame.right) {
        box.scrollLeft += rect.left - frame.left - frame.width / 2
      }
    }
    if (box === root) {
      return
    }
  }
}

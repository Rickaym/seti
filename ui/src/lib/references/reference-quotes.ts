import type { Nodes } from 'mdast'
import { clip } from '@/lib/links/link-services'
import { REF_PROPERTY, refValue, type ReferenceSet } from './reference-set'
import { plainText } from './reference-text'

const QUOTE_LIMIT = 280
const BLANK = /^[\s\p{P}]*$/u

type Marked = WeakMap<Nodes, number>

const childrenOf = (node: Nodes | undefined): Nodes[] =>
  node !== undefined && 'children' in node ? (node.children as Nodes[]) : []

/** The numbers of the references under `node`, in order. */
function numbersIn(node: Nodes, marked: Marked): number[] {
  const own = marked.get(node)
  return own === undefined ? childrenOf(node).flatMap((child) => numbersIn(child, marked)) : [own]
}

/** The one reference a paragraph cites, or null when it cites none or several. */
function onlyIn(node: Nodes | undefined, marked: Marked): number | null {
  if (node?.type !== 'paragraph') {
    return null
  }
  const numbers = new Set(numbersIn(node, marked))
  return numbers.size === 1 ? ([...numbers][0] ?? null) : null
}

/** The reference a paragraph ends with, punctuation aside, such as one before a colon. */
function endOf(node: Nodes | undefined, marked: Marked): number | null {
  if (node?.type !== 'paragraph') {
    return null
  }
  const last = childrenOf(node)
    .filter((child) => child.type !== 'text' || !BLANK.test(child.value))
    .at(-1)
  return last === undefined ? null : (marked.get(last) ?? null)
}

/** The reference a quote is tied to: one inside it, the one after it, or one leading into it. */
function sourceOf(siblings: readonly Nodes[], index: number, marked: Marked): number | null {
  const quote = siblings[index]
  const inside = quote === undefined ? undefined : numbersIn(quote, marked).at(-1)
  return inside ?? onlyIn(siblings[index + 1], marked) ?? endOf(siblings[index - 1], marked)
}

/** Ties each blockquote to the reference next to it and records the quote on that reference. */
export function tieQuotes(node: Nodes, marked: Marked, set: ReferenceSet): void {
  const siblings = childrenOf(node)
  siblings.forEach((child, index) => {
    const n = child.type === 'blockquote' ? sourceOf(siblings, index, marked) : null
    const ref = n === null ? undefined : set.refs[n - 1]
    if (ref !== undefined) {
      Object.assign(child, {
        data: { ...child.data, hProperties: { ...child.data?.hProperties, [REF_PROPERTY]: refValue(set, ref.n) } },
      })
      ref.quote ??= clip(plainText(child), QUOTE_LIMIT)
    }
    tieQuotes(child, marked, set)
  })
}

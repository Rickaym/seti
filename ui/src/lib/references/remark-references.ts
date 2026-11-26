import type { FootnoteReference, Link, LinkReference, Nodes, Parent, Root, RootContent, Text } from 'mdast'
import { textIsUrl } from '@/lib/links/bare-urls'
import { clip } from '@/lib/links/link-services'
import { tieQuotes } from './reference-quotes'
import { MAX_REFS, REF_PROPERTY, refValue, SOURCES_PROPERTY, type Reference, type ReferenceSet } from './reference-set'
import { isWebUrl, plainText } from './reference-text'

const NOTE_LIMIT = 200

interface Footnote {
  href: string | null
  note: string | null
}

interface State {
  set: ReferenceSet
  byKey: Map<string, Reference>
  /** Link definitions by identifier, for `[1]` and `[text][id]`. */
  urls: Map<string, string>
  footnotes: Map<string, Footnote>
  /** The reference number each marked node carries, for tying quotes. */
  marked: WeakMap<Nodes, number>
}

const isParent = (node: Nodes): node is Nodes & Parent => 'children' in node

/** Nodes whose content is never cited: code, raw HTML and images. */
const UNTOUCHED = new Set(['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition'])

/** Text that leaves a line empty for a link on it: blanks and punctuation. */
const BLANK = /^[\s\p{P}]*$/u

function collect(node: Nodes, found: (node: Nodes) => void): void {
  found(node)
  if (isParent(node)) {
    node.children.forEach((child: Nodes) => {
      collect(child, found)
    })
  }
}

const LEAD = /[\s\p{P}]/u
const TRAIL = /[\s,;:-]/

/** A footnote's words without the punctuation that joined them to its link. */
function trimEdges(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && LEAD.test(text.charAt(start))) {
    start++
  }
  while (end > start && TRAIL.test(text.charAt(end - 1))) {
    end--
  }
  return text.slice(start, end)
}

/** The first web link under `node`, with a `[text][id]` reference resolved. */
function firstLink(node: Nodes, urls: ReadonlyMap<string, string>): Link | null {
  if (node.type === 'link' && isWebUrl(node.url)) {
    return node
  }
  const url = node.type === 'linkReference' ? urls.get(node.identifier) : undefined
  if (url !== undefined && isWebUrl(url) && node.type === 'linkReference') {
    return { type: 'link', url, children: node.children }
  }
  for (const child of isParent(node) ? (node.children as Nodes[]) : []) {
    const found = firstLink(child, urls)
    if (found !== null) {
      return found
    }
  }
  return null
}

function footnoteOf(definition: Nodes, urls: ReadonlyMap<string, string>): Footnote {
  const link = firstLink(definition, urls)
  const bare = link !== null && textIsUrl(plainText(link), link.url)
  const words = trimEdges(plainText(definition, bare ? link : null))
  return { href: link?.url ?? null, note: words === '' ? null : clip(words, NOTE_LIMIT) }
}

function newState(tree: Root, set: ReferenceSet): State {
  const urls = new Map<string, string>()
  collect(tree, (node) => {
    if (node.type === 'definition') {
      urls.set(node.identifier, node.url)
    }
  })
  const footnotes = new Map<string, Footnote>()
  collect(tree, (node) => {
    if (node.type === 'footnoteDefinition') {
      footnotes.set(node.identifier, footnoteOf(node, urls))
    }
  })
  return { set, byKey: new Map(), urls, footnotes, marked: new WeakMap() }
}

function referenceFor(state: State, key: string, source: Footnote): Reference | null {
  const known = state.byKey.get(key)
  if (known !== undefined) {
    known.note ??= source.note
    return known
  }
  if (state.set.refs.length >= MAX_REFS) {
    return null
  }
  const ref: Reference = { n: state.set.refs.length + 1, href: source.href, note: source.note, quote: null }
  state.set.refs.push(ref)
  state.byKey.set(key, ref)
  return ref
}

function mark<T extends Nodes>(node: T, ref: Reference, state: State): T {
  const hProperties = { ...node.data?.hProperties, [REF_PROPERTY]: refValue(state.set, ref.n) }
  Object.assign(node, { data: { ...node.data, hProperties } })
  state.marked.set(node, ref.n)
  return node
}

/** A superscript mark standing for a reference; it copies as `[n]`. */
const markNode = (ref: Reference, state: State): Text =>
  mark({ type: 'text', value: `[${String(ref.n)}]`, data: { hName: 'sup' } }, ref, state)

function citeLink(link: Link, state: State): Link {
  if (!isWebUrl(link.url)) {
    return link
  }
  const ref = referenceFor(state, link.url, { href: link.url, note: null })
  return ref === null ? link : mark(link, ref, state)
}

function citeLinkReference(node: LinkReference, state: State): Nodes {
  const url = state.urls.get(node.identifier)
  if (url === undefined || !isWebUrl(url)) {
    return node
  }
  if (/^\d+$/.test(node.label ?? '') && node.referenceType !== 'full') {
    const ref = referenceFor(state, url, { href: url, note: null })
    return ref === null ? node : markNode(ref, state)
  }
  return citeLink({ type: 'link', url, children: node.children, position: node.position }, state)
}

function citeFootnote(node: FootnoteReference, state: State): Nodes {
  const footnote = state.footnotes.get(node.identifier)
  const ref =
    footnote === undefined ? null : referenceFor(state, footnote.href ?? `footnote:${node.identifier}`, footnote)
  return ref === null ? { type: 'text', value: `[^${node.label ?? node.identifier}]` } : markNode(ref, state)
}

/** Links alone on a line of a paragraph or table cell, which stay as they are. */
function loneLinks(parent: Parent): Set<Nodes> {
  const lone = new Set<Nodes>()
  if (parent.type !== 'paragraph' && parent.type !== 'tableCell') {
    return lone
  }
  let line: Nodes[] = []
  const close = () => {
    const [only] = line
    if (line.length === 1 && (only?.type === 'link' || only?.type === 'linkReference')) {
      lone.add(only)
    }
    line = []
  }
  for (const child of parent.children as Nodes[]) {
    if (child.type === 'break') {
      close()
    } else if (child.type === 'text') {
      child.value.split('\n').forEach((part, index) => {
        if (index > 0) {
          close()
        }
        if (!BLANK.test(part)) {
          line.push(child)
        }
      })
    } else {
      line.push(child)
    }
  }
  close()
  return lone
}

function cite(node: Nodes, state: State, lone: ReadonlySet<Nodes>): Nodes {
  if (lone.has(node) || UNTOUCHED.has(node.type)) {
    return node
  }
  if (node.type === 'link') {
    return citeLink(node, state)
  }
  if (node.type === 'linkReference') {
    return citeLinkReference(node, state)
  }
  if (node.type === 'footnoteReference') {
    return citeFootnote(node, state)
  }
  walk(node, state)
  return node
}

/** Cites the links and footnotes under `node` in document order; footnote bodies are dropped. */
function walk(node: Nodes, state: State): void {
  if (!isParent(node)) {
    return
  }
  const lone = loneLinks(node)
  const children = (node.children as Nodes[])
    .filter((child) => child.type !== 'footnoteDefinition')
    .map((child) => cite(child, state, lone))
  Object.assign(node, { children })
}

/** Where the Sources list renders, at the end of the message. */
const sourcesNode = (set: ReferenceSet): RootContent => ({
  type: 'paragraph',
  children: [],
  data: { hName: 'section', hProperties: { [SOURCES_PROPERTY]: set.token } },
})

/**
 * A remark plugin that turns links inside sentences, `[^n]` footnotes and `[n]` references into
 * numbered references, collected in `set`. A link alone on its line stays as it is.
 */
export const remarkReferences = (set: ReferenceSet) => () => (tree: Root) => {
  set.refs.splice(0)
  const state = newState(tree, set)
  walk(tree, state)
  tieQuotes(tree, state.marked, set)
  if (set.refs.length > 0) {
    tree.children.push(sourcesNode(set))
  }
}

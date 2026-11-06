import { fileUrlTarget } from '@seti/shared'
import type { Nodes, Parent, PhrasingContent, Root, Text } from 'mdast'

/** Links the path plugin makes carry this prefix, so the Markdown renderer can tell them apart. */
const FILE_HREF = '#seti-file='

/** Extensions that make a bare name in prose, such as notes.md, worth checking for a file. */
const PROSE_EXTENSIONS = [
  'md',
  'markdown',
  'mdx',
  'pdf',
  'txt',
  'json',
  'jsonl',
  'ya?ml',
  'toml',
  'csv',
  'tsv',
  'html?',
  'css',
  'scss',
  'tsx?',
  'jsx?',
  'mjs',
  'cjs',
  'py',
  'ipynb',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'sql',
  'log',
  'xml',
  'svg',
  'png',
  'jpe?g',
  'gif',
  'webp',
  'docx?',
  'xlsx?',
  'pptx?',
  'zip',
].join('|')

const FIRST = String.raw`[\w@+-]`
const SEGMENT = String.raw`${FIRST}[\w.@+-]*`
const DIR = String.raw`\.?${SEGMENT}\/`
const LAST = String.raw`${FIRST}(?:[\w.@+-]*[\w@+-])?`
const LOCATION = String.raw`(?::\d+(?::\d+)?)?`
const DIRS = String.raw`(?:~\/|\/)?(?:${DIR})+${LAST}`
const BARE = String.raw`${SEGMENT}\.(?:${PROSE_EXTENSIONS})`

/** A path in prose: one with a slash, or a bare name with a file extension. */
const IN_PROSE = new RegExp(String.raw`(?<![\w/.~:@-])(${DIRS}|${BARE})${LOCATION}(?![\w/@.-]*[\w/@-])`, 'gi')

/** A whole inline code span that is a path: a slash or any short extension. */
const IN_CODE = new RegExp(String.raw`^((?:~\/|\/)?(?:${DIR})*${LAST})${LOCATION}$`)

const MAX_LENGTH = 400

export interface PathMatch {
  start: number
  end: number
  /** The path without a :line or :line:col suffix. */
  path: string
}

const plausible = (candidate: string) =>
  candidate.length <= MAX_LENGTH && !/^\d+(?:[./]\d+)*$/.test(candidate) && !candidate.includes('//')

/** Paths mentioned in a stretch of prose, in order. */
export function pathsInText(text: string): PathMatch[] {
  const found: PathMatch[] = []
  for (const match of text.matchAll(IN_PROSE)) {
    const candidate = match[1] ?? ''
    if (plausible(candidate)) {
      found.push({ start: match.index, end: match.index + match[0].length, path: candidate })
    }
  }
  return found
}

/** The path an inline code span names, or null when it is not one. */
export function pathInCode(code: string): string | null {
  const match = IN_CODE.exec(code.trim())
  const candidate = match?.[1] ?? null
  if (candidate === null || !plausible(candidate)) {
    return null
  }
  return candidate.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(candidate) ? candidate : null
}

const FILE_SCHEME = /^file:\/\/(?:localhost)?(\/[^?#\s]*)$/i

/** What to resolve for a Files download link on any host or a file:// URL; null for other URLs. */
export function fileRefOfUrl(url: string): string | null {
  const text = url.trim()
  if (fileUrlTarget(text) !== null) {
    return text
  }
  const local = FILE_SCHEME.exec(text)?.[1]
  if (local === undefined) {
    return null
  }
  try {
    return decodeURIComponent(local)
  } catch {
    return null
  }
}

/** A URL in plain text: absolute, or a Files link without its origin. */
const URL_IN_TEXT = /(?:\b(?:https?|file):\/\/|(?<!\S)\/api\/tasks\/)[^\s<>"'`]+/gi
const URL_TAIL = /[.,;:!?)\]}]$/

export interface FileRefMatch {
  start: number
  end: number
  /** What to resolve: a path, or a Files link as written. */
  ref: string
}

/** File references in plain text, in order: Files links, file:// URLs and paths. */
export function fileRefsInText(text: string): FileRefMatch[] {
  const urls: FileRefMatch[] = []
  const taken: { start: number; end: number }[] = []
  for (const match of text.matchAll(URL_IN_TEXT)) {
    let url = match[0]
    while (URL_TAIL.test(url)) {
      url = url.slice(0, -1)
    }
    const span = { start: match.index, end: match.index + url.length }
    taken.push(span)
    const ref = fileRefOfUrl(url)
    if (ref !== null) {
      urls.push({ ...span, ref })
    }
  }
  const outside = (found: PathMatch) => taken.every((span) => found.end <= span.start || found.start >= span.end)
  const paths = pathsInText(text)
    .filter(outside)
    .map((found) => ({ start: found.start, end: found.end, ref: found.path }))
  return [...urls, ...paths].toSorted((a, b) => a.start - b.start)
}

/** A run of plain text, or a file reference with the text it replaces. */
export type TextPiece = { start: number; text: string } & ({ ref: null } | { ref: string; card: boolean })

interface Edges {
  /** The text starts a line, so its first line can stand alone. */
  first: boolean
  /** The text ends a line, so its last line can stand alone. */
  last: boolean
}

const blank = (text: string) => text.trim() === ''

/**
 * Plain text cut at its file references. A reference alone on its line becomes a card that
 * takes the line's newlines with it, so the text reads the same while the file is unknown.
 */
export function textPieces(text: string, { first, last }: Edges): TextPiece[] {
  const pieces: TextPiece[] = []
  let at = 0
  for (const match of fileRefsInText(text)) {
    const lineStart = text.lastIndexOf('\n', match.start - 1) + 1
    const newline = text.indexOf('\n', match.end)
    const lineEnd = newline < 0 ? text.length : newline
    const alone =
      (lineStart > 0 || first) &&
      (newline >= 0 || last) &&
      blank(text.slice(lineStart, match.start)) &&
      blank(text.slice(match.end, lineEnd))
    const start = alone ? Math.max(at, lineStart - 1, 0) : match.start
    const end = alone ? Math.min(lineEnd + 1, text.length) : match.end
    if (start > at) {
      pieces.push({ start: at, ref: null, text: text.slice(at, start) })
    }
    pieces.push({ start, ref: match.ref, text: text.slice(start, end), card: alone })
    at = end
  }
  if (at < text.length) {
    pieces.push({ start: at, ref: null, text: text.slice(at) })
  }
  return pieces
}

export const fileHref = (path: string) => `${FILE_HREF}${encodeURIComponent(path)}`

/** The path of a link the plugin made, or null for any other href. */
export const pathOfHref = (href: string | undefined): string | null =>
  href?.startsWith(FILE_HREF) === true ? decodeURIComponent(href.slice(FILE_HREF.length)) : null

const SKIPPED = new Set(['link', 'linkReference', 'code', 'html', 'definition', 'image', 'imageReference'])

function splitText(node: Text): PhrasingContent[] {
  const matches = pathsInText(node.value)
  if (matches.length === 0) {
    return [node]
  }
  const parts: PhrasingContent[] = []
  let at = 0
  for (const match of matches) {
    if (match.start > at) {
      parts.push({ type: 'text', value: node.value.slice(at, match.start) })
    }
    const value = node.value.slice(match.start, match.end)
    parts.push({ type: 'link', url: fileHref(match.path), children: [{ type: 'text', value }] })
    at = match.end
  }
  if (at < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(at) })
  }
  return parts
}

const isParent = (node: Nodes): node is Nodes & Parent => 'children' in node

function linkChild(child: Nodes): Nodes[] {
  if (child.type === 'text') {
    return splitText(child)
  }
  if (child.type === 'link') {
    const ref = fileRefOfUrl(child.url)
    return [ref === null ? child : { ...child, url: fileHref(ref) }]
  }
  const path = child.type === 'inlineCode' ? (fileRefOfUrl(child.value) ?? pathInCode(child.value)) : null
  if (path !== null) {
    return [{ type: 'link', url: fileHref(path), children: [child as PhrasingContent] }]
  }
  return [linkPaths(child)]
}

/** A copy of the node with paths in its text linked; skipped nodes come back as they are. */
function linkPaths(node: Nodes): Nodes {
  if (!isParent(node) || SKIPPED.has(node.type)) {
    return node
  }
  const children = (node.children as Nodes[]).flatMap(linkChild)
  return { ...node, children } as Nodes
}

/** A remark plugin that turns file paths in prose and inline code into links the renderer checks. */
export const remarkFilePaths = () => (tree: Root) => linkPaths(tree) as Root

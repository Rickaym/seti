import { createHash } from 'node:crypto'
import { parse as parseJs, tokenizer, tokTypes } from 'acorn'
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'

type HtmlNode = DefaultTreeAdapterTypes.Node

const ACORN = { ecmaVersion: 'latest', sourceType: 'module' } as const

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The file's text, or null when it is not UTF-8. */
export function textOf(bytes: Buffer): string | null {
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Why the logic bundle cannot run as one self-contained module, or null when it can. */
export function logicProblem(file: string, source: string): string | null {
  let program: ReturnType<typeof parseJs>
  try {
    program = parseJs(source, ACORN)
  } catch (e) {
    return `${file} is not valid JavaScript: ${errorText(e)}`
  }
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      return `${file} imports ${String(node.source.value)}; bundle everything into one file`
    }
    if (node.type === 'ExportAllDeclaration' || (node.type === 'ExportNamedDeclaration' && node.source !== null)) {
      return `${file} exports from another file; bundle everything into one file`
    }
  }
  for (const token of tokenizer(source, ACORN)) {
    if (token.type === tokTypes._import) {
      return `${file} uses import; a mod's logic loads nothing at run time`
    }
  }
  return null
}

const UNSAFE_URL = /^(?:javascript|vbscript):/

/** An attribute value as a browser reads a URL: no whitespace or control characters, lowercase. */
const urlOf = (value: string) =>
  Array.from(value, (char) => (char.trim() === '' || (char.codePointAt(0) ?? 0) <= 0x1f ? '' : char))
    .join('')
    .toLowerCase()

/** The CSP source of an inline script, as a hash-pinned page policy lists it. */
const scriptHash = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`

interface Walk {
  file: string
  hashes: string[]
}

function elementProblem(node: DefaultTreeAdapterTypes.Element, walk: Walk): string | null {
  const name = node.nodeName
  const attr = (wanted: string) => node.attrs.find((entry) => entry.name === wanted)
  if (name === 'base' || name === 'link') {
    return `${walk.file} has a <${name}>, which a view may not use; inline its styles`
  }
  if (name === 'meta' && attr('http-equiv') !== undefined) {
    return `${walk.file} has <meta http-equiv>, which a view may not set`
  }
  if (name === 'script' && (attr('src') !== undefined || attr('href') !== undefined)) {
    return `${walk.file} loads a script from a file; put every script inline`
  }
  const handler = node.attrs.find((entry) => entry.name.toLowerCase().startsWith('on'))
  if (handler !== undefined) {
    return `${walk.file} has an ${handler.name} attribute; attach handlers from a script instead`
  }
  const unsafe = node.attrs.find((entry) => UNSAFE_URL.test(urlOf(entry.value)))
  if (unsafe !== undefined) {
    return `${walk.file} has a javascript: URL in ${unsafe.name}`
  }
  if (name === 'script') {
    const text = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
    walk.hashes.push(scriptHash(text))
  }
  return null
}

function walkProblem(node: HtmlNode, walk: Walk): string | null {
  if ('tagName' in node) {
    const problem = elementProblem(node, walk)
    if (problem !== null) {
      return problem
    }
  }
  const children = [
    ...('childNodes' in node ? node.childNodes : []),
    ...('content' in node ? node.content.childNodes : []),
  ]
  for (const child of children) {
    const problem = walkProblem(child, walk)
    if (problem !== null) {
      return problem
    }
  }
  return null
}

/** The hashes of a view's inline scripts, or why the page cannot be served as a mod view. */
export function pageScripts(file: string, html: string): { hashes: string[] } | { problem: string } {
  const walk: Walk = { file, hashes: [] }
  const problem = walkProblem(parseHtml(html), walk)
  return problem === null ? { hashes: [...new Set(walk.hashes)] } : { problem }
}

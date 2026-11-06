import type { StreamParser } from '@codemirror/language'
import type { Parser, Tree } from '@lezer/common'
import { highlightCode, tags as t } from '@lezer/highlight'
import type { CodeLanguage } from './code-language.js'
import { syntaxHighlighter } from './highlight-tokens.js'

/** A run of code and the token class it shows in, empty for plain text. */
export interface Segment {
  text: string
  className: string
}

/** A stretch of the code to colour, as offsets from its start. */
export interface CodeRange {
  from: number
  to: number
}

type ParserLanguage = Exclude<CodeLanguage, 'diff'>

const javascript = async (dialect: string) =>
  import('@lezer/javascript').then((m) => (dialect === '' ? m.parser : m.parser.configure({ dialect })))

const streamed = async <State>(mode: Promise<StreamParser<State>>) => {
  const [{ StreamLanguage }, spec] = await Promise.all([import('@codemirror/language'), mode])
  return StreamLanguage.define(spec).parser
}

/** Env and ini files colour their keys alone, since values are often secrets or free text. */
function keysOnly<State>(mode: StreamParser<State>): StreamParser<State> {
  return {
    ...mode,
    tokenTable: { key: t.propertyName },
    token: (stream, state) => {
      const style = mode.token(stream, state)
      if (style === 'quote') {
        return null
      }
      return style === 'def' ? 'key' : style
    },
  }
}

/** Each grammar loads on first use, so a page of Python never fetches the Rust parser. */
const LOADERS: Record<ParserLanguage, () => Promise<Parser>> = {
  javascript: async () => javascript(''),
  typescript: async () => javascript('ts'),
  jsx: async () => javascript('jsx'),
  tsx: async () => javascript('jsx ts'),
  python: async () => import('@lezer/python').then((m) => m.parser),
  json: async () => import('@lezer/json').then((m) => m.parser),
  yaml: async () => import('@lezer/yaml').then((m) => m.parser),
  go: async () => import('@lezer/go').then((m) => m.parser),
  rust: async () => import('@lezer/rust').then((m) => m.parser),
  css: async () => import('@lezer/css').then((m) => m.parser),
  xml: async () => import('@lezer/xml').then((m) => m.parser),
  markdown: async () => import('@lezer/markdown').then((m) => m.parser),
  sql: async () => import('@codemirror/lang-sql').then((m) => m.StandardSQL.language.parser),
  bash: async () => streamed(import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  dockerfile: async () => streamed(import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)),
  toml: async () => streamed(import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  makefile: async () => streamed(import('./highlight-makefile.js').then((m) => m.makefile)),
  ini: async () => streamed(import('@codemirror/legacy-modes/mode/properties').then((m) => keysOnly(m.properties))),
  html: async () => {
    const [html, script, style] = await Promise.all([
      import('@lezer/html'),
      javascript(''),
      import('@lezer/css').then((m) => m.parser),
    ])
    const nest = html.configureNesting([
      { tag: 'script', parser: script },
      { tag: 'style', parser: style },
    ])
    return html.parser.configure({ wrap: nest })
  },
}

const parsers = new Map<ParserLanguage, Promise<Parser>>()

/** The parser of a language, loading its grammar on first use. */
export async function parserFor(language: ParserLanguage): Promise<Parser> {
  let parser = parsers.get(language)
  if (parser === undefined) {
    parser = LOADERS[language]()
    parsers.set(language, parser)
    parser.catch(() => parsers.delete(language))
  }
  return parser
}

const DIFF_HEAD = /^(?:diff |index |\+\+\+ |--- |@@)/

function diffClass(line: string): string {
  if (DIFF_HEAD.test(line)) {
    return 'tok-meta'
  }
  if (line.startsWith('+')) {
    return 'tok-inserted'
  }
  return line.startsWith('-') ? 'tok-deleted' : ''
}

/** Diff lines by their first character, the way a terminal diff colours them. */
function diffSegments(code: string): Segment[] {
  return code.split('\n').map((line, n) => ({ text: n === 0 ? line : `\n${line}`, className: diffClass(line) }))
}

function push(segments: Segment[], text: string, className: string) {
  const last = segments.at(-1)
  if (last?.className === className) {
    last.text += text
  } else {
    segments.push({ text, className })
  }
}

interface Parsed {
  code: string
  language: ParserLanguage
  tree: Tree
}

/** The last few trees, so the pieces of one long file share a single parse. */
const trees: Parsed[] = []
const TREES_KEPT = 4

function treeOf(code: string, language: ParserLanguage, parser: Parser): Tree {
  const kept = trees.find((entry) => entry.language === language && entry.code === code)
  if (kept !== undefined) {
    return kept.tree
  }
  const tree = parser.parse(code)
  trees.unshift({ code, language, tree })
  trees.length = Math.min(trees.length, TREES_KEPT)
  return tree
}

/** Pieces of the code split into runs by token class, one list per range. */
export async function highlightRanges(
  code: string,
  language: CodeLanguage,
  ranges: readonly CodeRange[],
): Promise<Segment[][]> {
  if (language === 'diff') {
    return ranges.map((range) => diffSegments(code.slice(range.from, range.to)))
  }
  const tree = treeOf(code, language, await parserFor(language))
  return ranges.map(({ from, to }) => {
    const segments: Segment[] = []
    highlightCode(
      code,
      tree,
      syntaxHighlighter,
      (text, className) => {
        push(segments, text, className)
      },
      () => {
        push(segments, '\n', '')
      },
      from,
      to,
    )
    return segments
  })
}

/** The code split into runs by token class. */
export async function highlight(code: string, language: CodeLanguage): Promise<Segment[]> {
  const [segments = []] = await highlightRanges(code, language, [{ from: 0, to: code.length }])
  return segments
}

export { syntaxHighlighter } from './highlight-tokens.js'

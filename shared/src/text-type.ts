/** What a piece of text looks like: the extension its file gets and the name people know it by. */
export interface TextType {
  ext: string
  label: string
}

const TEXT: TextType = { ext: 'txt', label: 'Text' }

const type = (ext: string, label: string): TextType => ({ ext, label })

/** Enough lines to judge the shape of a paste without scanning megabytes of it. */
const SAMPLE_LINES = 400

function sampleLines(text: string): string[] {
  return text
    .split('\n', SAMPLE_LINES)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
}

function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const startsLikeJson = (text: string) => text.startsWith('{') || text.startsWith('[')

function jsonType(text: string, lines: readonly string[]): TextType | null {
  if (!startsLikeJson(text)) {
    return null
  }
  if (parses(text)) {
    return type('json', 'JSON')
  }
  const records = lines.length >= 2 && lines.every((line) => startsLikeJson(line.trim()) && parses(line))
  return records ? type('jsonl', 'JSON Lines') : null
}

const SHEBANGS: [RegExp, TextType][] = [
  [/python/, type('py', 'Python')],
  [/\b(node|deno|bun)\b/, type('js', 'JavaScript')],
  [/\b(ba|z|k|da)?sh\b/, type('sh', 'Shell')],
]

function shebangType(first: string): TextType | null {
  if (!first.startsWith('#!')) {
    return null
  }
  return SHEBANGS.find(([pattern]) => pattern.test(first))?.[1] ?? null
}

function diffType(lines: readonly string[]): TextType | null {
  if (lines.some((line) => line.startsWith('diff --git '))) {
    return type('diff', 'Diff')
  }
  const minus = lines.findIndex((line) => line.startsWith('--- '))
  const plus = minus >= 0 && lines[minus + 1]?.startsWith('+++ ') === true
  return plus && lines.some((line) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) ? type('diff', 'Diff') : null
}

function markupType(text: string): TextType | null {
  const head = text.slice(0, 2000).toLowerCase()
  if (!head.startsWith('<') || !text.trimEnd().endsWith('>')) {
    return null
  }
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return type('html', 'HTML')
  }
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) {
    return type('svg', 'SVG')
  }
  if (head.startsWith('<?xml')) {
    return type('xml', 'XML')
  }
  return /^<([a-z][\w:-]*)[\s>][\s\S]*<\/\1>$/i.test(text.trim()) ? type('xml', 'XML') : null
}

const DOCKER_STEP = /^(FROM|RUN|CMD|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|ENTRYPOINT|USER|LABEL|VOLUME|HEALTHCHECK)\s/

function dockerfileType(lines: readonly string[]): TextType | null {
  const steps = lines.filter((line) => !line.trimStart().startsWith('#'))
  const first = steps[0] ?? ''
  if (!/^(FROM\s+\S+|ARG\s+\w+)/.test(first) || !steps.some((line) => line.startsWith('FROM '))) {
    return null
  }
  return steps.filter((line) => DOCKER_STEP.test(line)).length >= 2 ? type('dockerfile', 'Dockerfile') : null
}

const LOG_LINE = new RegExp(
  [
    String.raw`^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}`,
    String.raw`^\[?\d{2}:\d{2}:\d{2}`,
    String.raw`^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}`,
    String.raw`^\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?[\s:]`,
  ].join('|'),
)
const TRACE_LINES = [
  /^Traceback \(most recent call last\):/,
  /^\s+at [\w$.<>]+[ (]/,
  /^\s+File "[^"]+", line \d/,
  /^(Exception in thread |Caused by: |panic: )/,
  /^goroutine \d+ \[/,
  /^thread '[^']+' panicked at /,
]

function logType(lines: readonly string[]): TextType | null {
  const logged = lines.filter((line) => LOG_LINE.test(line)).length
  const traced = lines.filter((line) => TRACE_LINES.some((pattern) => pattern.test(line))).length
  if (traced >= 2 || (lines.length >= 3 && logged / lines.length >= 0.6)) {
    return type('log', 'Log')
  }
  return null
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6} \S/

function markdownScore(lines: readonly string[]): number {
  const signals = [
    lines.some((line) => HEADING.test(line)),
    lines.some((line) => FENCE.test(line)),
    lines.some((line) => line.includes('](')),
    lines.filter((line) => /^\s*([-*+]|\d+\.) \S/.test(line)).length >= 2,
    lines.some((line) => /(\*\*|__)\S.*\S(\*\*|__)/.test(line) || /^> \S/.test(line)),
    lines.some((line) => /^\|.*\|$/.test(line)) && lines.some((line) => /^\|?\s*:?-{3,}/.test(line)),
  ]
  return signals.filter(Boolean).length
}

interface Language {
  type: TextType
  /** Lines that only this language writes this way. */
  strong: RegExp[]
}

const LANGUAGES: Language[] = [
  {
    type: type('py', 'Python'),
    strong: [
      /^\s*def \w+\(.*\)( -> .+)?:\s*$/,
      /^\s*class \w+(\(.*\))?:\s*$/,
      /^from [\w.]+ import /,
      /^import \w+(\.\w+)*( as \w+)?$/,
      /^if __name__ == ['"]__main__['"]:/,
      /^\s*(else|try|finally):$/,
      /^\s*(elif|except) [^:]*:$/,
      /^\s*@\w+(\.\w+)*(\(.*\))?$/,
    ],
  },
  {
    type: type('ts', 'TypeScript'),
    strong: [
      /^\s*(export )?(interface|type) \w+(<.+>)? [={]/,
      /^\s*(export )?(const|let) \w+: [\w<>[\]|' ]+ =/,
      /\): (string|number|boolean|void|Promise<.+>)( \{|$)/,
      /^\s*(public|private|readonly) \w+: /,
      /^import type /,
      / as const\b/,
    ],
  },
  {
    type: type('js', 'JavaScript'),
    strong: [
      /^\s*(export )?(async )?function\*? \w+\(/,
      /^\s*(const|let|var) \w+ = (require\(|async |\(.*\) =>|function)/,
      /^\s*module\.exports\b/,
      /^import .+ from ['"].+['"];?$/,
      /^\s*export (default |const |\{)/,
      /\bconsole\.(log|error|warn)\(/,
    ],
  },
  {
    type: type('go', 'Go'),
    strong: [
      /^package \w+$/,
      /^func (\(\w+ \*?\w+\) )?\w+\(/,
      /^import \($/,
      /\w := /,
      /\bfmt\.\w+\(/,
      /\bif err != nil \{/,
    ],
  },
  {
    type: type('rs', 'Rust'),
    strong: [
      /^\s*(pub(\(crate\))? )?(async )?fn \w+(<.+>)?\(/,
      /^\s*let mut \w+/,
      /^\s*impl(<.+>)? \w+/,
      /^use \w+(::\w+)+/,
      /\b\w+!\(/,
      /^\s*#\[derive\(/,
    ],
  },
  {
    type: type('java', 'Java'),
    strong: [
      /^package [\w.]+;$/,
      /^import (static )?[\w.*]+;$/,
      /^\s*(public|private|protected) (static )?(final )?(class|interface|enum|record) \w+/,
      /^\s*(public|private|protected) (static )?[\w<>[\]]+ \w+\(.*\)\s*(throws [\w, ]+)?\{?$/,
      /\bSystem\.out\.print/,
    ],
  },
  {
    type: type('kt', 'Kotlin'),
    strong: [
      /^package [\w.]+$/,
      /^\s*(private |internal |override )?(suspend )?fun (<.+> )?\w+\(/,
      /^\s*(data |sealed )?class \w+\(/,
      /^\s*(val|var) \w+(: [\w<>?]+)? = /,
      /^import [\w.]+$/,
    ],
  },
  {
    type: type('cpp', 'C++'),
    strong: [
      /^#include <(iostream|vector|string|memory|map|algorithm)>/,
      /\bstd::\w+/,
      /^\s*(template ?<|namespace \w+|using namespace )/,
      /^\s*class \w+ (final )?(: (public|private) \w+ )?\{/,
    ],
  },
  {
    type: type('c', 'C'),
    strong: [
      /^#include [<"][\w/]+\.h[>"]/,
      /^#(define|ifndef|ifdef|endif|pragma)\b/,
      /^\s*(int|void|char|static \w+) \*?\w+\(.*\)\s*\{?$/,
      /\b(printf|malloc|free|sizeof)\(/,
    ],
  },
  {
    type: type('sql', 'SQL'),
    strong: [
      /^\s*SELECT\s.+\sFROM\s/i,
      /^\s*(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LEFT JOIN|INNER JOIN|JOIN)\b/,
      /^\s*(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE (OR REPLACE )?(TABLE|INDEX|VIEW|FUNCTION)|ALTER TABLE|DROP TABLE)\b/i,
      /^\s*WITH \w+ AS \(/i,
    ],
  },
  {
    type: type('sh', 'Shell'),
    strong: [
      /^\s*(sudo|apt|apt-get|brew|npm|pnpm|yarn|pip|uv) /,
      /^\s*(git|docker|kubectl|curl|wget|chmod|mkdir|cd|export|echo|source) /,
      /^\s*\$ \S/,
      /^\s*(if \[\[? .+ \]\]?; then|fi|done|esac|then|do)$/,
      /^\s*for \w+ in .+; do$/,
      /^\s*\w+=("|\$\(|\w)/,
      / \\$/,
    ],
  },
]

/** Languages that share most of their syntax with a superset, which wins on any sign of itself. */
const SUPERSETS: Record<string, string> = { js: 'ts', c: 'cpp' }

const familyOf = (ext: string) =>
  Object.entries(SUPERSETS).find(([base, sup]) => ext === base || ext === sup)?.[0] ?? ext

/** The language most lines read as, when it clearly beats every other; null when unsure. */
function codeType(lines: readonly string[]): TextType | null {
  const scores = LANGUAGES.map((language) => ({
    type: language.type,
    score: lines.filter((line) => language.strong.some((pattern) => pattern.test(line))).length,
  })).toSorted((a, b) => b.score - a.score)
  const [best] = scores
  if (best === undefined || best.score < 2 || best.score < lines.length * 0.08) {
    return null
  }
  const family = familyOf(best.type.ext)
  const rival = scores.find((entry) => familyOf(entry.type.ext) !== family)?.score ?? 0
  if (best.score <= rival * 1.5) {
    return null
  }
  const superset = scores.find((entry) => entry.type.ext === SUPERSETS[family])
  return superset !== undefined && superset.score > 0 ? superset.type : best.type
}

const YAML_LINES = [/^\s*(- )?[\w"'./-]+:(\s+\S.*)?$/, /^\s*- \S/, /^---$/, /^\s*#/]

function yamlType(lines: readonly string[]): TextType | null {
  const pairs = lines.filter((line) => /^\s*(- )?[\w"'./-]+:\s+\S/.test(line)).length
  const shaped = lines.filter((line) => YAML_LINES.some((pattern) => pattern.test(line))).length
  return lines.length >= 2 && pairs >= 1 && shaped / lines.length >= 0.9 ? type('yaml', 'YAML') : null
}

const TOML_PAIR = /^[\w"'.-]+\s*=\s*("|'|\d|true\b|false\b|\[|\{)/

function tomlType(lines: readonly string[]): TextType | null {
  const sections = lines.filter((line) => /^\[{1,2}[\w"'. -]+\]{1,2}$/.test(line.trim())).length
  const pairs = lines.filter((line) => TOML_PAIR.test(line.trim())).length
  const comments = lines.filter((line) => line.trim().startsWith('#')).length
  const shaped = sections + pairs + comments === lines.length
  return shaped && sections >= 1 && pairs >= 1 ? type('toml', 'TOML') : null
}

/** Delimiters outside double quotes on one line. */
function fieldBreaks(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
    } else if (char === delimiter && !quoted) {
      count += 1
    }
  }
  return count
}

function tableType(lines: readonly string[]): TextType | null {
  if (lines.length < 3) {
    return null
  }
  for (const [delimiter, found] of [
    ['\t', type('tsv', 'TSV')],
    [',', type('csv', 'CSV')],
  ] as const) {
    const breaks = lines.map((line) => fieldBreaks(line, delimiter))
    const first = breaks[0] ?? 0
    if (first >= 1 && breaks.filter((count) => count === first).length / breaks.length >= 0.9) {
      return found
    }
  }
  return null
}

const MARKDOWN = type('md', 'Markdown')

/** Markdown that also holds code or config is still Markdown when it has headings or much else. */
const clearMarkdown = (lines: readonly string[]) => {
  const score = markdownScore(lines)
  return score >= 3 || (score >= 2 && lines.some((line) => HEADING.test(line))) ? MARKDOWN : null
}

type Detector = (text: string, lines: readonly string[]) => TextType | null

/** Tried in order: exact formats first, then the shapes that are easier to mistake. */
const DETECTORS: Detector[] = [
  jsonType,
  (_text, lines) => shebangType(lines[0] ?? ''),
  (_text, lines) => diffType(lines),
  (text) => markupType(text),
  (_text, lines) => dockerfileType(lines),
  (_text, lines) => logType(lines),
  (_text, lines) => clearMarkdown(lines),
  (_text, lines) => tomlType(lines),
  (_text, lines) => codeType(lines),
  (_text, lines) => yamlType(lines),
  (_text, lines) => tableType(lines),
  (_text, lines) => (markdownScore(lines) >= 2 ? MARKDOWN : null),
]

/** Guesses pasted text's type from its content; plain text whenever no format clearly fits. */
export function detectTextType(text: string): TextType {
  const trimmed = text.trim()
  if (trimmed === '') {
    return TEXT
  }
  const lines = sampleLines(trimmed)
  for (const detect of DETECTORS) {
    const found = detect(trimmed, lines)
    if (found !== null) {
      return found
    }
  }
  return TEXT
}

/** The languages code blocks highlight. */
export type CodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'jsx'
  | 'tsx'
  | 'python'
  | 'bash'
  | 'json'
  | 'yaml'
  | 'sql'
  | 'go'
  | 'rust'
  | 'diff'
  | 'css'
  | 'html'
  | 'xml'
  | 'markdown'
  | 'dockerfile'
  | 'makefile'
  | 'toml'
  | 'ini'

/** Longer code stays plain, so one huge block never stalls the page. */
export const HIGHLIGHT_LIMIT = 50_000

/** Files with a longer line stay plain, as VS Code stops colouring a line at 20,000 characters. */
export const HIGHLIGHT_LINE_MAX = 20_000

/** The length of the text's longest line, without its newline. */
export function longestLine(text: string): number {
  let longest = 0
  let start = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', start)) {
    longest = Math.max(longest, at - start)
    start = at + 1
  }
  return Math.max(longest, text.length - start)
}

/** Whether a code block is small enough, and its lines short enough, to colour. */
export const highlightable = (code: string) => code.length <= HIGHLIGHT_LIMIT && longestLine(code) <= HIGHLIGHT_LINE_MAX

const ALIASES = new Map<string, CodeLanguage>(
  Object.entries({
    js: 'javascript',
    javascript: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    py: 'python',
    python: 'python',
    python3: 'python',
    sh: 'bash',
    bash: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    shellsession: 'bash',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    jsonl: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sql: 'sql',
    postgres: 'sql',
    postgresql: 'sql',
    psql: 'sql',
    mysql: 'sql',
    sqlite: 'sql',
    go: 'go',
    golang: 'go',
    rust: 'rust',
    rs: 'rust',
    diff: 'diff',
    patch: 'diff',
    css: 'css',
    html: 'html',
    htm: 'html',
    vue: 'html',
    xml: 'xml',
    svg: 'xml',
    xsd: 'xml',
    xsl: 'xml',
    plist: 'xml',
    csproj: 'xml',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    dockerfile: 'dockerfile',
    docker: 'dockerfile',
    containerfile: 'dockerfile',
    makefile: 'makefile',
    make: 'makefile',
    mk: 'makefile',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    properties: 'ini',
    env: 'ini',
    dotenv: 'ini',
    editorconfig: 'ini',
    gitconfig: 'ini',
    pyi: 'python',
    bashrc: 'bash',
    zshrc: 'bash',
  } satisfies Record<string, CodeLanguage>),
)

/** The language a fence's tag names, such as `ts` or `Shell`, or null for one not highlighted. */
export function languageOf(tag: string | null | undefined): CodeLanguage | null {
  return tag === null || tag === undefined ? null : (ALIASES.get(tag.trim().toLowerCase()) ?? null)
}

/** The language of a fence from its code element's classes, as Markdown renders `language-ts`. */
export function languageOfClasses(classes: unknown): CodeLanguage | null {
  if (!Array.isArray(classes)) {
    return null
  }
  for (const name of classes) {
    if (typeof name === 'string' && name.startsWith('language-')) {
      return languageOf(name.slice('language-'.length))
    }
  }
  return null
}

/** Files whose whole name says their language, as an extension would. */
const NAMED_FILES: readonly [RegExp, CodeLanguage][] = [
  [/^(?:docker|container)file(?:\..+)?$|\.dockerfile$/, 'dockerfile'],
  [/^(?:gnu)?makefile$/, 'makefile'],
  [/^\.env(?:\..+)?$/, 'ini'],
]

/** The language of a file from its name, such as `app.ts`, `Dockerfile` or `.env.local`. */
export function languageOfPath(path: string): CodeLanguage | null {
  const name = (path.split('/').at(-1) ?? path).toLowerCase()
  const named = NAMED_FILES.find(([pattern]) => pattern.test(name))
  if (named !== undefined) {
    return named[1]
  }
  const dot = name.lastIndexOf('.')
  return dot === -1 ? null : languageOf(name.slice(dot + 1))
}

const DIFF_HEADER = /^(?:diff --git |--- \S|@@ -\d)/m
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m
const SHELL_START = /^(?:#!\/(?:usr\/)?bin\/(?:env )?(?:ba|z)?sh\b|\$ \S)/

/** Whether the text is one JSON value, checked cheaply before parsing. */
export function isJson(text: string): boolean {
  const start = text.trimStart()[0]
  if ((start !== '{' && start !== '[') || text.length > HIGHLIGHT_LIMIT) {
    return false
  }
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** A guess at the language of an untagged block: JSON, a diff or a shell session, else none. */
export function guessLanguage(code: string): CodeLanguage | null {
  if (isJson(code)) {
    return 'json'
  }
  if (DIFF_HEADER.test(code) && DIFF_HUNK.test(code)) {
    return 'diff'
  }
  return SHELL_START.test(code) ? 'bash' : null
}

/** A JSON string, a bracket or separator, or a bare literal such as a number. */
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g

const CLOSER: Readonly<Record<string, string>> = { '{': '}', '[': ']' }

/** Indents one-line JSON two spaces a level, keeping every number and string as written. */
function reindent(text: string): string {
  const tokens = text.match(JSON_TOKEN) ?? []
  let depth = 0
  const pad = () => `\n${'  '.repeat(depth)}`
  return tokens
    .map((token, n) => {
      const closer = CLOSER[token]
      if (closer !== undefined) {
        if (tokens[n + 1] === closer) {
          return token
        }
        depth += 1
        return token + pad()
      }
      if (token === '}' || token === ']') {
        if (tokens[n - 1] === '{' || tokens[n - 1] === '[') {
          return token
        }
        depth -= 1
        return pad() + token
      }
      if (token === ',') {
        return `,${pad()}`
      }
      return token === ':' ? ': ' : token
    })
    .join('')
}

/** JSON to show in a tool block: one-line JSON comes back indented, other JSON as it is. */
export function jsonText(text: string): string | null {
  if (!isJson(text)) {
    return null
  }
  const trimmed = text.trim()
  return trimmed.includes('\n') ? trimmed : reindent(trimmed)
}

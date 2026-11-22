/** What a rule matches, read from its text once. */
export type RuleTarget =
  | { type: 'tool'; name: string }
  | { type: 'tool-glob'; glob: string }
  | { type: 'command'; pattern: string }
  | { type: 'path'; tool: 'Read' | 'Edit'; pattern: string }
  | { type: 'domain'; pattern: string }
  | { type: 'mcp'; server: string; tool: string | null }
  | { type: 'agent'; pattern: string }
  | { type: 'param'; tool: string; key: string; value: string }
  | { type: 'opaque'; name: string }
  | { type: 'never' }

const KEY = /^[A-Za-z_]\w*$/

/** Fields holding what a tool acts on; a parameter rule on one could be dodged. */
const PRIMARY = new Set(['command', 'file_path', 'path', 'notebook_path', 'url'])

/** Fields a parameter rule may name on tools whose parentheses otherwise hold a pattern. */
const PARAMS: Record<string, readonly string[]> = {
  Bash: ['run_in_background', 'timeout', 'description', 'dangerouslyDisableSandbox'],
  Read: ['offset', 'limit', 'pages'],
  Edit: ['replace_all'],
  Agent: ['model', 'isolation', 'subagent_type', 'run_in_background', 'name', 'mode', 'team_name'],
}

const ALIASES: Record<string, string> = { Task: 'Agent' }

/** Tools whose path rules Claude Code accepts but never matches; `Edit` or `Read` say it. */
const PATHLESS = new Set(['Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])

const hasGlob = (text: string) => /[*?]/.test(text)

function mcpTarget(name: string): RuleTarget {
  const rest = name.slice('mcp__'.length)
  const split = rest.indexOf('__')
  const server = split === -1 ? rest : rest.slice(0, split)
  if (hasGlob(server) || server === '') {
    return { type: 'tool-glob', glob: name }
  }
  return { type: 'mcp', server, tool: split === -1 ? null : rest.slice(split + 2) }
}

/** A `key:value` parameter rule, or null when the text is the tool's own pattern. */
function paramTarget(tool: string, spec: string, known: readonly string[] | undefined): RuleTarget | null {
  const colon = spec.indexOf(':')
  const key = spec.slice(0, Math.max(colon, 0)).trim()
  if (!KEY.test(key)) {
    return null
  }
  if (PRIMARY.has(key)) {
    return { type: 'never' }
  }
  if (known !== undefined && !known.includes(key)) {
    return null
  }
  return { type: 'param', tool, key, value: spec.slice(colon + 1).trim() }
}

function specTarget(tool: string, spec: string): RuleTarget {
  const param = paramTarget(tool, spec, tool === 'WebFetch' ? undefined : PARAMS[tool])
  if (tool === 'WebFetch') {
    return spec.startsWith('domain:')
      ? { type: 'domain', pattern: spec.slice('domain:'.length).trim() }
      : (param ?? { type: 'never' })
  }
  if (param !== null) {
    return param
  }
  if (tool === 'Bash') {
    return { type: 'command', pattern: spec }
  }
  if (tool === 'Read' || tool === 'Edit') {
    return { type: 'path', tool, pattern: spec }
  }
  if (tool === 'Agent') {
    return { type: 'agent', pattern: spec }
  }
  return PATHLESS.has(tool) ? { type: 'never' } : { type: 'opaque', name: tool }
}

/** A rule's tool part and what its parentheses hold, or null when they do not close at the end. */
function partsOf(text: string): { raw: string; spec?: string } | null {
  const open = text.indexOf('(')
  if (open === -1) {
    return text.includes(')') ? null : { raw: text }
  }
  return text.endsWith(')') ? { raw: text.slice(0, open).trim(), spec: text.slice(open + 1, -1).trim() } : null
}

/** Reads a rule's text: a tool name, a name glob, or a tool with what it matches in parentheses. */
export function parseRule(text: string): RuleTarget {
  const parts = partsOf(text.trim())
  if (parts === null || parts.raw === '') {
    return { type: 'never' }
  }
  const { raw, spec } = parts
  if (raw.startsWith('mcp__')) {
    return spec === undefined ? mcpTarget(raw) : { type: 'never' }
  }
  if (hasGlob(raw)) {
    return spec === undefined ? { type: 'tool-glob', glob: raw } : { type: 'never' }
  }
  const name = ALIASES[raw] ?? raw
  if (spec === undefined || spec === '*') {
    return { type: 'tool', name }
  }
  return spec === '' ? { type: 'never' } : specTarget(name, spec)
}

const INTERPRETERS = new Set([
  'python',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'lua',
  'luajit',
  'pwsh',
  'osascript',
  'tclsh',
  'rscript',
  'julia',
  'java',
  'awk',
  'gawk',
])
const WRAPPER_WORDS = new Set([
  'timeout',
  'time',
  'nice',
  'nohup',
  'stdbuf',
  'command',
  'builtin',
  'noglob',
  'xargs',
  'env',
  'sudo',
  'exec',
  'watch',
  'setsid',
  'ionice',
  'flock',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const RUN_WORDS = new Set(['run', 'exec', 'x', 'dlx', 'start', 'test'])
const DIRECT_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'make'])
const RUN_TOOLS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'cargo', 'go', 'pipx'])

/** The command words before the first wildcard of a shell pattern. */
function fixedWords(pattern: string): string[] {
  const text = pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern
  return (text.split('*')[0] ?? '').split(' ').filter((word) => word !== '')
}

function runsPackages(words: readonly string[]): boolean {
  const [program = '', sub] = words
  if (DIRECT_RUNNERS.has(program)) {
    return true
  }
  if (PACKAGE_MANAGERS.has(program)) {
    return sub === undefined || RUN_WORDS.has(sub)
  }
  return RUN_TOOLS.has(program) && sub === 'run'
}

/** An interpreter's name without its version, such as python for python3.12. */
const interpreter = (program: string) => program.toLowerCase().split(/\d/)[0] ?? ''

function broadShell(pattern: string): boolean {
  if (!pattern.includes('*')) {
    return false
  }
  const words = fixedWords(pattern)
  const [program = ''] = words
  return (
    program === '' ||
    /[/$~]/.test(program) ||
    INTERPRETERS.has(interpreter(program)) ||
    (words.length === 1 && WRAPPER_WORDS.has(program)) ||
    runsPackages(words)
  )
}

/**
 * Whether an allow rule stops counting in auto mode, as Claude Code drops rules that grant any
 * code: the whole shell, interpreters, wrappers or package runners with a wildcard, subagents.
 */
export function droppedInAuto(target: RuleTarget): boolean {
  if (target.type === 'tool') {
    return ['Bash', 'Agent', 'Monitor', 'PowerShell'].includes(target.name)
  }
  return target.type === 'agent' || (target.type === 'command' && broadShell(target.pattern))
}

import path from 'node:path'
import { agentTexts, rowEvents, toolEnds, type DigestKind, type MessageRow, type SubtaskBrief } from '@seti/shared'
import { digestByRow } from '../digest.js'
import { redactCredentials, redactSecrets } from '../scrub.js'
import { deriveTodos } from '../todos.js'

/** The most a brief holds, in characters; the oldest steps of what was done go first. */
const BRIEF_CHARS = 12_000

const FIRST_ASK_CHARS = 2000
const LATER_ASK_CHARS = 600
const LATER_ASKS = 3
const PLAN_ITEMS = 20
const DONE_LINES = 40
const FILES = 50
const LAST_WORDS_CHARS = 1500
const CUT = '\n[... cut]'

/** What a brief is built from: an agent's facts and its rows as the receiver may see them. */
export interface BriefSource {
  title: string
  runtime: string
  model: string | null
  role: string | null
  cwd: string
  pr_urls: readonly string[]
  /** The agent ended its last turn on a question to the user. */
  asking: boolean
  /** Oldest first, with direct messages the receiver may not see already hidden. */
  rows: readonly MessageRow[]
  subtasks?: readonly SubtaskBrief[]
}

/** A brief's text, and whether anything was left out to keep it within its size. */
interface Brief {
  text: string
  cut: boolean
}

/** The digest kinds a brief keeps as done: the agent's words, its calls, subagents and turn ends. */
const DONE_KINDS: ReadonlySet<DigestKind> = new Set(['agent', 'tool', 'subtask', 'shell', 'status'])

const clean = (text: string) => redactSecrets(redactCredentials(text)).trim()

/** Redacts before cutting, so a cut never leaves part of a credential behind. */
function clip(text: string, max: number): string {
  const safe = clean(text)
  return safe.length <= max ? safe : `${safe.slice(0, max - 3).trimEnd()}...`
}

/** The user's own messages, oldest first; updates and taken-back messages are not asks. */
function asks(rows: readonly MessageRow[]): string[] {
  return rows.flatMap((row) =>
    row.kind === 'prompt' &&
    row.payload.auto !== true &&
    row.payload.queued !== 'removed' &&
    row.payload.text.trim() !== ''
      ? [row.payload.text]
      : [],
  )
}

function askedSection(rows: readonly MessageRow[]): string[] {
  const [first, ...later] = asks(rows)
  if (first === undefined) {
    return []
  }
  const recent = later.slice(-LATER_ASKS).map((text) => `- ${clip(text, LATER_ASK_CHARS)}`)
  return ['## Asked', clip(first, FIRST_ASK_CHARS), ...(recent.length === 0 ? [] : ['', 'Later:', ...recent])]
}

function planSection(rows: readonly MessageRow[]): string[] {
  const items = deriveTodos(rows).slice(0, PLAN_ITEMS)
  return items.length === 0 ? [] : ['## Plan', ...items.map((item) => `- [${item.status}] ${clip(item.content, 200)}`)]
}

function doneLines(rows: readonly MessageRow[], subtasks: readonly SubtaskBrief[]): string[] {
  return digestByRow(rows, subtasks)
    .flatMap((row) => row.lines)
    .filter((line) => DONE_KINDS.has(line.kind))
    .map((line) => `- ${clean(line.text)}`)
    .slice(-DONE_LINES)
}

/** Paths the agent's own edits that ended well touched, relative to its folder where inside it. */
function changedFiles(rows: readonly MessageRow[], cwd: string): string[] {
  const ends = toolEnds(rows)
  const paths = rows.flatMap((row) =>
    rowEvents(row).flatMap((event) =>
      event.type === 'tool.started' && event.thread === '' && ends.get(event.call.callId)?.status === 'ok'
        ? (event.call.edit?.changes ?? []).map((change) => change.path)
        : [],
    ),
  )
  const shown = paths.map((file) => {
    const relative = path.relative(cwd, file)
    return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative
  })
  return [...new Set(shown)].slice(-FILES)
}

const lastWords = (rows: readonly MessageRow[]) =>
  rows.flatMap((row) => agentTexts(rowEvents(row))).findLast((text) => text.trim() !== '')

function closingSection(source: BriefSource): string[] {
  const words = lastWords(source.rows)
  if (words === undefined) {
    return []
  }
  return [source.asking ? '## Open question to the user' : '## Last words', clip(words, LAST_WORDS_CHARS)]
}

function header(source: BriefSource): string[] {
  const model = source.model === null ? '' : `, model ${source.model}`
  return [
    `# Brief of the agent "${clean(source.title)}"`,
    `Runtime: ${source.runtime}${model}`,
    ...(source.role === null ? [] : [`Role: ${clean(source.role)}`]),
    `Working folder: ${source.cwd}`,
  ]
}

const section = (title: string, lines: readonly string[]) => (lines.length === 0 ? [] : [title, ...lines])

/** The brief's text with the given done lines, sections apart by a blank line. */
function render(source: BriefSource, done: readonly string[]): string {
  const files = changedFiles(source.rows, source.cwd).map((file) => `- ${clean(file)}`)
  const parts = [
    header(source),
    askedSection(source.rows),
    planSection(source.rows),
    section('## Done, newest last', done),
    section('## Files changed', files),
    section(
      '## Pull requests',
      source.pr_urls.map((url) => `- ${url}`),
    ),
    closingSection(source),
  ]
  return parts
    .filter((part) => part.length > 0)
    .map((part) => part.join('\n'))
    .join('\n\n')
}

/**
 * What another agent needs to carry on from this one, built from neutral events only, so it reads
 * the same for every runtime: what was asked, the plan, what was done, the files and PRs, and the
 * last words. Every text is redacted; the oldest steps go first to keep it within `max`.
 */
export function buildBrief(source: BriefSource, max = BRIEF_CHARS): Brief {
  const done = doneLines(source.rows, source.subtasks ?? [])
  for (let from = 0; from <= done.length; from += 1) {
    const text = render(source, done.slice(from))
    if (text.length <= max) {
      return { text, cut: from > 0 }
    }
  }
  return { text: `${render(source, []).slice(0, max - CUT.length)}${CUT}`, cut: true }
}

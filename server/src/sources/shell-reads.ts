import path from 'node:path'
import type { ToolCall } from '@seti/shared'
import { tasks } from '../db.js'
import { rawWords } from '../policy/shell-forms.js'
import { walkLine } from '../policy/shell-scope.js'
import { shellSteps, type ShellStep } from '../policy/shell-split.js'
import { fileItem, placeFile } from './files.js'
import { linesLocator, NUMBERED, type FoundItem } from './item.js'
import { unquote } from './line-output.js'

/** A shell line that may print files with `cat`, `head`, `tail`, `sed -n` or `nl`. */
export interface ShellReadAsk {
  command: string
}

/** What a read prints of its file: all of it, lines `from` to `to` (null: the end), the last few. */
type Printed = { whole: true; numbered: boolean } | { from: number; to: number | null } | { last: number }

interface ShellRead {
  file: string
  printed: Printed
}

/** The lines of the file a result shows; null for the whole file. */
interface Shown {
  lines: readonly [number, number] | null
}

const MENTION = /(?:^|[\s;&(])(?:cat|head|tail|sed|nl)\s/
const JOINS = new Set(['', ';', '&&', '\n'])
/** A word the shell expands or redirects, so the step may not print the one file it names as is. */
const SHELL_WORD = /[*?[\]{}$`<>~\\]|^\d*[<>]|^&>/
const COUNT = /^[1-9]\d{0,8}$/
const SED_LINES = /^([1-9]\d{0,8})(?:,([1-9]\d{0,8}))?p$/
const COUNT_JOINED = /^(?:-n|--lines=)(\+?\d+)$|^-(\d+)$/

/** The line of a call that may read files through the shell, or null for any other call. */
export function shellReadAsk(call: ToolCall): ShellReadAsk | null {
  const command = call.shell?.action === 'run' ? call.shell.command : undefined
  return command !== undefined && MENTION.test(` ${command}`) ? { command } : null
}

/** The one file a command names after a leading `--`, or null for none or several. */
function alone(args: readonly string[]): string | null {
  const rest = args[0] === '--' ? args.slice(1) : args
  return rest.length === 1 ? (rest[0] ?? null) : null
}

/** The line count `head` and `tail` take (`-n N`, `-nN`, `--lines=N`, `-N`), '' when not given. */
function countOption(args: readonly string[]): { value: string; rest: readonly string[] } {
  const [first = '', second = ''] = args
  if (first === '-n' || first === '--lines') {
    return { value: second, rest: args.slice(2) }
  }
  const joined = COUNT_JOINED.exec(first)
  return joined === null ? { value: '', rest: args } : { value: joined[1] ?? joined[2] ?? '', rest: args.slice(1) }
}

type Parsed = { name: string; printed: Printed } | null

const whole = (args: readonly string[], numbered: boolean): Parsed => {
  const name = alone(args)
  return name === null ? null : { name, printed: { whole: true, numbered } }
}

function head(args: readonly string[]): Parsed {
  const { value, rest } = countOption(args)
  const name = alone(rest)
  const count = value === '' ? 10 : Number(value)
  return name === null || (value !== '' && !COUNT.test(value)) ? null : { name, printed: { from: 1, to: count } }
}

function tail(args: readonly string[]): Parsed {
  const { value, rest } = countOption(args)
  const name = alone(rest)
  if (name === null) {
    return null
  }
  if (value.startsWith('+')) {
    return COUNT.test(value.slice(1)) ? { name, printed: { from: Number(value.slice(1)), to: null } } : null
  }
  return value === '' || COUNT.test(value) ? { name, printed: { last: value === '' ? 10 : Number(value) } } : null
}

function sed(args: readonly string[]): Parsed {
  const [quiet, script = '', ...files] = args
  const lines = quiet === '-n' ? SED_LINES.exec(script) : null
  const name = alone(files)
  if (lines === null || name === null) {
    return null
  }
  const from = Number(lines[1])
  const to = lines[2] === undefined ? from : Number(lines[2])
  return to < from ? null : { name, printed: { from, to } }
}

const READERS: ReadonlyMap<string, (args: readonly string[]) => Parsed> = new Map([
  ['cat', (args: readonly string[]) => whole(args, false)],
  ['nl', (args: readonly string[]) => whole(args, true)],
  ['head', head],
  ['tail', tail],
  ['sed', sed],
])

/** Whether a step prints one named file, keeps the first lines of one, or changes folder. */
function plainStep(step: ShellStep): boolean {
  const [program = '', ...args] = rawWords(step.text)
  const piped = step.before === '|'
  const shape = step.nested.length === 0 && !step.guarded && (piped || JOINS.has(step.before))
  const ends = JOINS.has(step.after) || (step.after === '|' && program !== 'cd')
  const known = piped ? program === 'head' : program === 'cd' || READERS.has(program)
  const folder = program !== 'cd' || (args.length === 1 && args[0] !== '-')
  return shape && ends && known && folder && args.every((word) => !SHELL_WORD.test(word))
}

function readOf(words: readonly string[], dir: string | null): ShellRead | null {
  const [program = '', ...args] = words.map(unquote)
  const parsed = READERS.get(program)?.(args) ?? null
  if (parsed === null || parsed.name === '' || parsed.name.startsWith('-')) {
    return null
  }
  if (path.isAbsolute(parsed.name)) {
    return { file: path.normalize(parsed.name), printed: parsed.printed }
  }
  return dir === null ? null : { file: path.resolve(dir, parsed.name), printed: parsed.printed }
}

/** A read cut to its first `count` lines by a `head` it pipes into; null when that cannot be said. */
function firstLines(read: ShellRead | null, words: readonly string[]): ShellRead | null {
  const { value, rest } = countOption(words.slice(1).map(unquote))
  const count = value === '' ? 10 : Number(value)
  if (read === null || rest.length > 0 || (value !== '' && !COUNT.test(value)) || 'last' in read.printed) {
    return null
  }
  const { from, to } = 'whole' in read.printed ? { from: 1, to: null } : read.printed
  const last = from + count - 1
  return { file: read.file, printed: { from, to: to === null ? last : Math.min(to, last) } }
}

/**
 * The files a line prints, in order, when every command in it is a plain read, a `head` a read
 * pipes into, or a `cd`. The walk visits the line's steps in order, so each visit is its step.
 */
function readsOf(command: string, cwd: string | null): ShellRead[] {
  const steps = shellSteps(command)
  if (steps.length === 0 || !steps.every(plainStep)) {
    return []
  }
  const reads: (ShellRead | null)[] = []
  let at = 0
  walkLine(command, { cwd, home: null }, (forms, dir) => {
    const words = forms.at(-1) ?? []
    if (steps[at++]?.before === '|') {
      reads.push(firstLines(reads.pop() ?? null, words))
    } else if (READERS.has(unquote(words[0] ?? ''))) {
      reads.push(readOf(words, dir))
    }
  })
  return reads.every((read) => read !== null) ? reads : []
}

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length

/**
 * The lines a read showed. Alone on its line, its result is its output, so the count of lines
 * printed bounds them, and a result longer than the read prints gives none. Beside other reads,
 * the lines are the ones it asked for, when it named both ends.
 */
function shownBy(printed: Printed, count: number | null): Shown | null {
  if ('whole' in printed) {
    return { lines: null }
  }
  if ('last' in printed) {
    return count !== null && count < printed.last ? { lines: null } : null
  }
  if (count === null) {
    return printed.to === null ? null : { lines: [printed.from, printed.to] }
  }
  const last = printed.from + count - 1
  return printed.to !== null && last > printed.to ? null : { lines: [printed.from, last] }
}

function spansOf(read: ShellRead, { lines }: Shown, single: boolean): string[] {
  if (!single) {
    return []
  }
  if (lines !== null) {
    return [linesLocator(lines)]
  }
  return 'whole' in read.printed && read.printed.numbered ? [NUMBERED] : ['']
}

/**
 * The files a shell line printed with plain reads, each placed in its clone as a file read is.
 * A line that prints one file gives an item whose text is the result; a line of several reads
 * gives items with no text, since the result does not say where one file ends.
 */
export async function shellReadItems(taskId: string, ask: ShellReadAsk, text: string): Promise<FoundItem[]> {
  const task = await tasks.get(taskId)
  const reads = task === undefined || text.trim() === '' ? [] : readsOf(ask.command, task.cwd)
  const count = reads.length === 1 ? lineCount(text) : null
  const items = await Promise.all(
    reads.map(async (read) => {
      const shown = shownBy(read.printed, count)
      const placed = shown === null ? null : await placeFile(taskId, read.file).catch(() => null)
      if (shown === null || placed === null) {
        return []
      }
      return [fileItem(placed, shown.lines, spansOf(read, shown, count !== null))]
    }),
  )
  return items.flat()
}

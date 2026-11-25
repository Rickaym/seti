import path from 'node:path'
import { expand, expandPartly } from './shell-expand.js'
import { denyForms, rawWords } from './shell-forms.js'
import { shellSteps, type ShellStep } from './shell-split.js'

/** One command of a line, its words expanded where Seti can, and the folder it runs in. */
export type Visit = (forms: readonly string[][], dir: string | null) => void

const NESTING = 3
const SEPARATORS = new Set(['', ';', '\n', '&', ';;'])
const PIPES = new Set(['|', '|&'])
const ASSIGNED = /^([A-Za-z_]\w*)(\+?=|\[)/
const SETTERS = new Set(['let', 'declare', 'typeset', 'local'])
const DIR = 'dir'

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/** Every word of a line and of the scripts it nests, as written. */
function lineWords(line: string, depth: number): string[] {
  return shellSteps(line).flatMap((step) => [
    ...rawWords(step.text),
    ...(depth < NESTING ? step.nested.flatMap((script) => lineWords(script, depth + 1)) : []),
  ])
}

/** Whether a word as written runs arithmetic, which can set any name: `((...))`, `$((...))`. */
const arithmetic = (word: string) => word.startsWith('((') || (!word.startsWith("'") && /\$\(\(|\$\[/.test(word))

/**
 * Names the line sets only by one literal assignment, if at all. A name it also reads into,
 * loops over, unsets, exports or assigns twice never resolves; nor any name beside arithmetic.
 */
function trustedNames(line: string): (name: string) => boolean {
  const written = lineWords(line, 0)
  const words = written.map(unquote)
  if (written.some(arithmetic) || words.some((word) => SETTERS.has(word))) {
    return () => false
  }
  const uses = new Map<string, number>()
  const plain = new Set<string>()
  for (const word of words) {
    const assigned = ASSIGNED.exec(word)
    const name = assigned?.[1] ?? word
    uses.set(name, (uses.get(name) ?? 0) + 1)
    if (assigned?.[2] === '=') {
      plain.add(name)
    }
  }
  return (name) => {
    const count = uses.get(name) ?? 0
    const defaulted = line.includes(`\${${name}:=`) || line.includes(`\${${name}=`)
    return !defaulted && (count === 0 || (count === 1 && plain.has(name)))
  }
}

/** What the shell knows at a point of a line: its folder, the folders pushd saved, variables. */
class Scope {
  dir: string | null
  private readonly stack: (string | null)[]
  readonly vars: Map<string, string | null>
  /** What a step after `&&` changed, unknown once the line goes on without that step. */
  private readonly pending = new Set<string>()

  constructor(dir: string | null, stack: (string | null)[], vars: Map<string, string | null>) {
    this.dir = dir
    this.stack = stack
    this.vars = vars
  }

  copy(): Scope {
    return new Scope(this.dir, [...this.stack], new Map(this.vars))
  }

  /** The folder a `cd` or `pushd` names, from the folder the line is in. */
  private target(words: readonly string[]): string | null {
    const given = words.slice(1).find((word) => !/^-[LPe@]+$/.test(word))
    const named = given === undefined ? (this.vars.get('HOME') ?? null) : expand(given, this.vars)
    if (named === null || named === '' || named === '-') {
      return null
    }
    if (path.isAbsolute(named)) {
      return path.resolve(named)
    }
    return this.dir === null ? null : path.resolve(this.dir, named)
  }

  /** What a `cd`, `pushd` or `popd` does, as the keys it changes. */
  move(words: readonly string[]): string[] {
    const program = unquote(words[0] ?? '')
    if (program === 'cd' || program === 'pushd') {
      const to = this.target(words)
      if (program === 'pushd') {
        this.stack.push(this.dir)
      }
      this.dir = to
      return [DIR]
    }
    if (program === 'popd') {
      this.dir = this.stack.pop() ?? null
      return [DIR]
    }
    return []
  }

  /** What a step of plain assignments sets, as the keys it changes; any other assignment unsets. */
  assign(words: readonly string[], trusted: (name: string) => boolean): string[] {
    const from = words[0] === 'export' || words[0] === 'readonly' ? 1 : 0
    const rest = words.slice(from)
    const count = rest.findIndex((word) => !ASSIGNED.test(word))
    const sets = rest.slice(0, count < 0 ? rest.length : count).map((word) => ASSIGNED.exec(word))
    const names = sets.map((set) => set?.[1] ?? '')
    const plain = count < 0 && sets.length > 0 && sets.every((set) => set?.[2] === '=')
    names.forEach((name, at) => {
      const value = plain && trusted(name) ? expand(words[from + at]?.slice(name.length + 1) ?? '', this.vars) : null
      this.vars.set(name, value)
    })
    return names.map((name) => `$${name}`)
  }

  /** What `source` does: any variable may now hold anything. */
  sourced(): string[] {
    const names = [...this.vars.keys()]
    names.forEach((name) => this.vars.set(name, null))
    return names.map((name) => `$${name}`)
  }

  private forget(key: string): void {
    if (key === DIR) {
      this.dir = null
    } else {
      this.vars.set(key.slice(1), null)
    }
  }

  /** Keeps what a step changed only as far as it surely ran. */
  settle(step: ShellStep, changed: readonly string[]): void {
    if (step.guarded || step.before === '||') {
      changed.forEach((key) => {
        this.forget(key)
      })
    } else if (!SEPARATORS.has(step.before)) {
      changed.forEach((key) => this.pending.add(key))
    }
    if (step.after === '||' || SEPARATORS.has(step.after)) {
      this.pending.forEach((key) => {
        this.forget(key)
      })
      this.pending.clear()
    }
  }
}

interface Walk {
  trusted: (name: string) => boolean
  visit: Visit
}

/** Changes a command makes to the shell it runs in, as the keys it changes. */
function effects(forms: readonly string[][], scope: Scope, walk: Walk, depth: number): string[] {
  const assigned = scope.assign(forms[0] ?? [], walk.trusted)
  const words = forms[forms.length - 1] ?? []
  const program = unquote(words[0] ?? '')
  if (program === 'source' || program === '.') {
    return [...assigned, ...scope.sourced()]
  }
  if (program === 'eval' && depth < NESTING) {
    walkSteps(words.slice(1).join(' '), scope, walk, depth + 1)
    return assigned
  }
  return [...assigned, ...scope.move(words)]
}

function walkSteps(line: string, scope: Scope, walk: Walk, depth: number): void {
  for (const step of shellSteps(line)) {
    if (depth < NESTING) {
      step.nested.forEach((script) => {
        walkSteps(script, scope.copy(), walk, depth + 1)
      })
    }
    const forms = denyForms(step.text).map((form) => rawWords(form))
    walk.visit(
      forms.map((words) => words.map((word) => expandPartly(word, scope.vars))),
      scope.dir,
    )
    const own = !PIPES.has(step.before) && !PIPES.has(step.after) && step.after !== '&'
    scope.settle(step, own ? effects(forms, scope, walk, depth) : [])
  }
}

/**
 * Walks a shell line command by command as its shell would: following `cd`, `pushd` and `popd`,
 * `~` and `$HOME`, and variables given one literal value, each only as far as it surely ran.
 */
export function walkLine(line: string, start: { cwd: string | null; home: string | null }, visit: Visit): void {
  const trusted = trustedNames(line)
  const vars = new Map<string, string | null>()
  if (start.home !== null && trusted('HOME')) {
    vars.set('HOME', start.home)
  }
  walkSteps(line, new Scope(start.cwd, [], vars), { trusted, visit }, 0)
}

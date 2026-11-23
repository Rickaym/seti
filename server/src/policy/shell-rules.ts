import { insideAny, pathMatches, resolvePath } from './paths.js'
import { commandMatches } from './patterns.js'
import type { Prepared } from './rule-match.js'
import { isProtected } from './safety.js'
import { commandShape, denyForms, type CommandShape } from './shell-forms.js'
import { splitShell } from './shell-split.js'
import type { PolicyContext } from './types.js'

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed'])

const operands = (words: readonly string[]) => words.slice(1).filter((word) => !word.startsWith('-'))

/** Files a command reads or writes that Claude Code checks against `Read` and `Edit` rules. */
function fileAccess(shape: CommandShape): { reads: string[]; writes: string[] } {
  const [program = ''] = shape.words
  const args = operands(shape.words)
  const sed = program === 'sed'
  const inPlace = sed && shape.words.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith('--in-place'))
  const files = sed ? args.slice(1) : args
  const reads = READERS.has(program) ? files : []
  const writes = program === 'tee' || inPlace ? files : []
  return {
    reads: [...reads, ...shape.redirects.filter((r) => r.dir === 'in').map((r) => r.target)],
    writes: [...writes, ...shape.redirects.filter((r) => r.dir === 'out').map((r) => r.target)],
  }
}

/** The first deny or ask rule a command matches anywhere in it, by its text or the files it names. */
export function shellMatch(command: string, rules: readonly Prepared[], ctx: PolicyContext): Prepared | undefined {
  const parts = splitShell(command).all
  const forms = parts.flatMap(denyForms)
  const access = parts.map(commandShape).map(fileAccess)
  const touches = (pattern: string, paths: string[], rule: Prepared) =>
    paths.some((given) =>
      pathMatches(pattern, resolvePath(given, ctx.cwd, ctx.home), rule.rule.behavior, {
        anchor: rule.rule.anchor,
        cwd: ctx.cwd,
        home: ctx.home,
      }),
    )
  return rules.find(({ target, rule }) => {
    if (target.type === 'command') {
      return forms.some((form) => commandMatches(target.pattern, form))
    }
    if (target.type === 'path' && rule.behavior === 'deny') {
      const paths = access.flatMap((one) => (target.tool === 'Read' ? one.reads : one.writes))
      return touches(target.pattern, paths, { target, rule })
    }
    return false
  })
}

const TRIVIAL = new Set(['pwd', 'true', 'echo'])
const UNSURE_PATH = /[~*?[$`]/

/** Whether Claude Code lets an allow rule approve the files a command writes and reads. */
function filesAllowed(shapes: readonly CommandShape[], rules: readonly Prepared[], ctx: PolicyContext): boolean {
  const moves = shapes.some((shape) => shape.words[0] === 'cd')
  const allowedBy = (tool: 'Read' | 'Edit', target: string) =>
    rules.some(
      ({ target: t, rule }) =>
        (t.type === 'tool' && t.name === tool) ||
        (t.type === 'path' &&
          t.tool === tool &&
          pathMatches(t.pattern, target, 'allow', { anchor: rule.anchor, cwd: ctx.cwd, home: ctx.home })),
    )
  const ok = (given: string, tool: 'Read' | 'Edit') => {
    if (UNSURE_PATH.test(given) || (moves && !given.startsWith('/'))) {
      return false
    }
    const target = resolvePath(given, ctx.cwd, ctx.home)
    return (tool === 'Read' || !isProtected(target)) && (insideAny(target, ctx.dirs) || allowedBy(tool, target))
  }
  return shapes.every((shape) => {
    const tee = shape.words[0] === 'tee' ? operands(shape.words) : []
    const outs = [...tee, ...shape.redirects.filter((r) => r.dir === 'out').map((r) => r.target)]
    const ins = shape.redirects.filter((r) => r.dir === 'in').map((r) => r.target)
    return outs.every((given) => ok(given, 'Edit')) && ins.every((given) => ok(given, 'Read'))
  })
}

/** A `cd` to a literal path inside the working directories, which Claude Code reads as read-only. */
function trivial(shape: CommandShape, ctx: PolicyContext): boolean {
  const [program = '', target] = shape.words
  if (program === 'cd') {
    return (
      target !== undefined && !UNSURE_PATH.test(target) && insideAny(resolvePath(target, ctx.cwd, ctx.home), ctx.dirs)
    )
  }
  return TRIVIAL.has(program)
}

/** A `cd` to another directory before `git` may run that directory's hooks, so it always asks. */
const cdThenGit = (shapes: readonly CommandShape[], ctx: PolicyContext) =>
  shapes.some((s) => s.words[0] === 'cd' && resolvePath(s.words[1] ?? '~', ctx.cwd, ctx.home) !== ctx.cwd) &&
  shapes.some((s) => s.words[0] === 'git')

/** The allow rule that matches one command; some commands take only an exact rule. */
function allowRuleFor(shape: CommandShape, rules: readonly Prepared[], interactive: boolean): Prepared | undefined {
  const exact = shape.exactOnly || interactive
  return rules.find(
    ({ target }) =>
      target.type === 'command' &&
      !(exact && target.pattern.includes('*')) &&
      shape.forms.some((form) => commandMatches(target.pattern, form)),
  )
}

/**
 * The allow rule that approves every command of the line, or undefined. A line Seti cannot fully
 * read, a write outside the working directories or to a protected path, or a command no rule
 * names leaves the call to the mode.
 */
export function shellAllow(
  command: string,
  interactive: boolean,
  rules: readonly Prepared[],
  ctx: PolicyContext,
): Prepared | undefined {
  const split = splitShell(command)
  const whole = rules.find(({ target }) => target.type === 'tool' && target.name === 'Bash')
  const shapes = (split.plain ? split.top : split.all).map(commandShape)
  if ((whole === undefined && !split.plain) || !filesAllowed(shapes, rules, ctx) || cdThenGit(shapes, ctx)) {
    return undefined
  }
  if (whole !== undefined) {
    return whole
  }
  let first: Prepared | undefined
  for (const shape of shapes) {
    const rule = trivial(shape, ctx) ? undefined : allowRuleFor(shape, rules, interactive)
    if (rule === undefined && !trivial(shape, ctx)) {
      return undefined
    }
    first ??= rule
  }
  return first
}

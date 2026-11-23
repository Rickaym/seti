import { everyPlace, insideAny, resolvePath } from './paths.js'
import { commandShape, rawWords } from './shell-forms.js'
import { cdThenGit } from './shell-rules.js'
import { splitShell } from './shell-split.js'
import type { PolicyContext, Resolved } from './types.js'

/** What a command's words are: its program and arguments, quotes removed, and as written. */
interface Words {
  words: readonly string[]
  raw: readonly string[]
}

const operands = (words: readonly string[]) => words.slice(1).filter((word) => !word.startsWith('-'))

/** Whether a word as written holds a glob character outside quotes, which the shell expands. */
function unquotedGlob(raw: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? ''
    if (char === '\\' && quote !== "'") {
      i += 1
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char
    } else if (quote === char) {
      quote = null
    } else if (quote === null && '*?['.includes(char)) {
      return true
    }
  }
  return false
}

const GLOB = /[*?[]/
const DOTS = /(^|\/)\.\.(\/|$)/

/**
 * Whether a path a command reads stays inside the working directories. A glob or a path after a
 * `cd` must be relative with no `..`, so it cannot leave the directory it starts from.
 */
function readsInside(given: string, moved: boolean, ctx: ReadContext): boolean {
  if (given.startsWith('~')) {
    return false
  }
  if (GLOB.test(given) || (moved && !given.startsWith('/'))) {
    return !given.startsWith('/') && !DOTS.test(given)
  }
  return everyPlace(resolvePath(given, ctx.cwd, ctx.home), ctx.resolved, (place) => insideAny(place, ctx.dirs))
}

/** The call's context and where the paths it names lead. */
type ReadContext = PolicyContext & { resolved?: Resolved | undefined }

type Check = (command: Words, ctx: ReadContext, moved: boolean) => boolean

/** The values options carry after `=`, such as a file a `--files0-from=` reads. */
const optionValues = (words: readonly string[]) =>
  words
    .slice(1)
    .flatMap((word) => (word.startsWith('-') && word.includes('=') ? [word.slice(word.indexOf('=') + 1)] : []))

const pathsInside: Check = ({ words }, ctx, moved) =>
  [...operands(words), ...optionValues(words)].every((given) => readsInside(given, moved, ctx))

/** `grep` reads its first operand as the pattern unless `-e` or `-f` gives it. */
const grep: Check = ({ words }, ctx, moved) => {
  const given = words.some((word) => /^-[A-Za-z]*[ef]/.test(word) || /^--(regexp|file)/.test(word))
  const paths = [...operands(words).slice(given ? 0 : 1), ...optionValues(words)]
  return paths.every((path) => readsInside(path, moved, ctx))
}

/** `find` reads from the paths before its first expression; an action or a loose glob writes. */
const find: Check = ({ words, raw }, ctx, moved) => {
  const start = words.slice(1).findIndex((word) => /^[-(!]/.test(word))
  const roots = words.slice(1, start === -1 ? undefined : start + 1)
  return !raw.some(unquotedGlob) && roots.every((root) => readsInside(root, moved, ctx))
}

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame'])
/** Git flags that write a file, run another program or read outside the repository. */
const GIT_WRITES = /^--(output|ext-diff|textconv|no-index)/

/** Read-only `git` subcommands, with nothing before the subcommand that changes where it runs. */
const git: Check = ({ words, raw }) =>
  READ_ONLY_GIT.has(words[1] ?? '') && !raw.some(unquotedGlob) && !words.some((word) => GIT_WRITES.test(word))

/** `cd` to a literal path inside the working directories. */
const cd: Check = ({ words }, ctx, moved) => {
  const [, target, ...rest] = words
  return target !== undefined && rest.length === 0 && !GLOB.test(target) && readsInside(target, moved, ctx)
}

const COMMANDS: Record<string, Check> = {
  ls: pathsInside,
  cat: pathsInside,
  head: pathsInside,
  tail: pathsInside,
  wc: pathsInside,
  stat: pathsInside,
  du: pathsInside,
  diff: pathsInside,
  echo: () => true,
  pwd: () => true,
  which: ({ words }) => words.slice(1).every((word) => word === '-a' || !word.startsWith('-')),
  grep,
  find,
  git,
  cd,
}

/** Characters that redirect, substitute or expand: a line with any is not read-only. */
const UNREAD = /[<>$`]/

/**
 * Whether a shell line only reads, by Seti's own small list: every command on it is one the
 * list names, run directly, reading inside the working directories. A line it cannot fully read,
 * with a redirect, substitution, variable or wrapper, or a `cd` before `git`, is not read-only.
 */
export function readOnly(command: string, policy: PolicyContext, resolved?: Resolved): boolean {
  const ctx: ReadContext = { ...policy, resolved }
  const split = splitShell(command)
  if (!split.plain || UNREAD.test(command)) {
    return false
  }
  const shapes = split.top.map(commandShape)
  if (cdThenGit(shapes, ctx)) {
    return false
  }
  let moved = false
  return split.top.every((part) => {
    const shape = commandShape(part)
    const check = COMMANDS[shape.words[0] ?? '']
    const direct = shape.forms.length === 1 && !shape.exactOnly
    const ok = direct && check?.({ words: shape.words, raw: rawWords(part) }, ctx, moved) === true
    moved ||= shape.words[0] === 'cd'
    return ok
  })
}

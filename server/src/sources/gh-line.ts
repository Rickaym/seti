import { ghWrites } from '../policy/outward-gh.js'
import { rerouting } from '../policy/outward.js'
import { rawWords } from '../policy/shell-forms.js'
import { walkLine } from '../policy/shell-scope.js'
import { shellCommands, shellSteps, type ShellStep } from '../policy/shell-split.js'
import { ghRead, type GhRead } from './gh-command.js'
import { cleanFilter } from './gh-filters.js'

/**
 * What a line's result holds: one read's output as gh printed it, that output cut by filters
 * that add nothing, or more than one read's text.
 */
export type GhOutput = 'whole' | 'cut' | 'mixed'

/** The GitHub reads of one shell line and what its result holds. */
export interface GhLine {
  reads: GhRead[]
  output: GhOutput
}

const PIPES = new Set(['|', '|&'])
const QUIET = new Set(['cd', 'pushd', 'popd', 'true', ':'])
const ASSIGNMENT = /^[A-Za-z_]\w*=[^$`]*$/
/** A redirection of standard output, so what the command prints is not in the result. */
const STDOUT = /^(?:1?>>?|&>>?|>\|)/

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/** A step's words without redirections and leading literal assignments, unquoted. */
function programWords(step: ShellStep): string[] {
  const words = rawWords(step.text).filter((word) => !/^\d*[<>]/.test(word) && !word.startsWith('&>'))
  const first = words.findIndex((word) => !ASSIGNMENT.test(word))
  return first < 0 ? [] : words.slice(first).map(unquote)
}

/** Whether a step prints nothing: a folder change, a literal assignment, or no command at all. */
const quiet = (step: ShellStep) => {
  const words = programWords(step)
  return words.length === 0 || QUIET.has(words[0] ?? '')
}

/** What the line prints: one gh read, whole or through filters that add nothing, or more. */
function outputOf(steps: readonly ShellStep[]): GhOutput {
  if (steps.some((step) => step.nested.length > 0 || step.guarded || step.after === '&')) {
    return 'mixed'
  }
  const [head, ...more] = steps.filter((step) => !PIPES.has(step.before) && !quiet(step))
  const followers = steps.filter((step) => PIPES.has(step.before))
  const alone =
    head !== undefined &&
    more.length === 0 &&
    programWords(head)[0] === 'gh' &&
    followers.every((step) => cleanFilter(programWords(step)))
  if (!alone) {
    return 'mixed'
  }
  return followers.length === 0 ? 'whole' : 'cut'
}

/** Whether some gh command of the line sends what it prints to a file rather than the result. */
const ghToFile = (line: string) =>
  shellCommands(line).some((command) => {
    const words = rawWords(command)
    return words.some((word) => unquote(word) === 'gh') && words.some((word) => STDOUT.test(word))
  })

/**
 * The GitHub reads a shell line makes with gh, read past `cd`, literal variables and wrappers as
 * the outward check reads them. A read whose words the shell computes, such as a loop variable,
 * is left out; so is every write, and every read in a line that sets GH_REPO or GH_HOST.
 */
export function ghLine(command: string): GhLine {
  if (rerouting(shellCommands(command)).gh !== undefined || ghToFile(command)) {
    return { reads: [], output: 'mixed' }
  }
  const reads: GhRead[] = []
  walkLine(command, { cwd: null, home: null }, (forms) => {
    const words = forms.find((form) => form[0] === 'gh')
    const known = words !== undefined && !words.some((word) => /[$`]/.test(word))
    const read = known && ghWrites(words, null).length === 0 ? ghRead(words) : null
    if (read !== null) {
      reads.push(read)
    }
  })
  return { reads, output: reads.length === 1 ? outputOf(shellSteps(command)) : 'mixed' }
}

import { rawWords } from '../policy/shell-forms.js'
import { shellCommands, shellSteps, type ShellStep } from '../policy/shell-split.js'
import { cleanFilter } from './gh-filters.js'

/**
 * What a line's result holds: one read's output as its program printed it, that output cut by
 * filters that add nothing, or more than one read's text.
 */
export type LineOutput = 'whole' | 'cut' | 'mixed'

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

/** What a line prints: one run of `program`, whole or through filters that add nothing, or more. */
export function lineOutput(line: string, program: string): LineOutput {
  const steps = shellSteps(line)
  if (steps.some((step) => step.nested.length > 0 || step.guarded || step.after === '&')) {
    return 'mixed'
  }
  const [head, ...more] = steps.filter((step) => !PIPES.has(step.before) && !quiet(step))
  const followers = steps.filter((step) => PIPES.has(step.before))
  const alone =
    head !== undefined &&
    more.length === 0 &&
    programWords(head)[0] === program &&
    followers.every((step) => cleanFilter(programWords(step)))
  if (!alone) {
    return 'mixed'
  }
  return followers.length === 0 ? 'whole' : 'cut'
}

/** Whether some run of `program` in the line sends what it prints to a file, not the result. */
export const printsToFile = (line: string, program: string) =>
  shellCommands(line).some((command) => {
    const words = rawWords(command)
    return words.some((word) => unquote(word) === program) && words.some((word) => STDOUT.test(word))
  })

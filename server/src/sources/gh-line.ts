import { ghWrites } from '../policy/outward-gh.js'
import { rerouting } from '../policy/outward.js'
import { walkLine } from '../policy/shell-scope.js'
import { shellCommands } from '../policy/shell-split.js'
import { ghRead, type GhRead } from './gh-command.js'
import { lineOutput, printsToFile, type LineOutput } from './line-output.js'

/** The GitHub reads of one shell line and what its result holds. */
export interface GhLine {
  reads: GhRead[]
  output: LineOutput
}

/**
 * The GitHub reads a shell line makes with gh, read past `cd`, literal variables and wrappers as
 * the outward check reads them. A read whose words the shell computes, such as a loop variable,
 * is left out; so is every write, and every read in a line that sets GH_REPO or GH_HOST.
 */
export function ghLine(command: string): GhLine {
  if (rerouting(shellCommands(command)).gh !== undefined || printsToFile(command, 'gh')) {
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
  return { reads, output: reads.length === 1 ? lineOutput(command, 'gh') : 'mixed' }
}

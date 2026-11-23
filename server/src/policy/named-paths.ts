import { resolvePath } from './paths.js'
import { commandShape } from './shell-forms.js'
import { splitShell } from './shell-split.js'
import type { PolicyCall, PolicyContext } from './types.js'

/** A call names at most this many paths for its caller to resolve; the rest are taken as given. */
const NAMED_MAX = 64

/** Words that expand or substitute, which name no path Seti can know before the shell runs. */
const UNSURE = /[*?[$`]/

/** The words of a shell line that may name a file: arguments, option values and redirect targets. */
function shellWords(command: string): string[] {
  return splitShell(command).all.flatMap((part) => {
    const shape = commandShape(part)
    const args = shape.words.slice(1).flatMap((word) => {
      if (!word.startsWith('-')) {
        return [word]
      }
      return word.includes('=') ? [word.slice(word.indexOf('=') + 1)] : []
    })
    return [...args, ...shape.redirects.map((redirect) => redirect.target)]
  })
}

/**
 * The absolute paths a call may name, for its caller to resolve on disk before `decide`: the
 * files a file tool reads or writes, and the words of a shell line that may be files. Pure: it
 * reads no disk itself.
 */
export function namedPaths(call: PolicyCall, ctx: Pick<PolicyContext, 'cwd' | 'home'>): string[] {
  const given = [...call.reads, ...call.writes, ...(call.command === undefined ? [] : shellWords(call.command))]
  const absolute = given
    .filter((word) => word !== '' && !UNSURE.test(word))
    .map((word) => resolvePath(word, ctx.cwd, ctx.home))
  return [...new Set(absolute)].slice(0, NAMED_MAX)
}

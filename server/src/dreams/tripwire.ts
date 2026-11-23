import { redactSecrets } from '../scrub.js'

const HOST = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\b/gi
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl|ruby)\b/
const COMMANDING = /\b(?:ignore (?:all |any |the |previous |your )?(?:rules|instructions)|always run|never tell)\b/i
const SHOWN = 120

const hostsOf = (text: string) => new Set([...text.matchAll(HOST)].map((m) => (m[1] ?? '').toLowerCase()))

/** Lines the change added that are not in the earlier text, as a multiset. */
function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>()
  for (const line of before.split('\n')) {
    left.set(line, (left.get(line) ?? 0) + 1)
  }
  return after.split('\n').filter((line) => {
    const n = left.get(line) ?? 0
    left.set(line, n - 1)
    return n <= 0 && line.trim() !== ''
  })
}

function why(line: string, known: ReadonlySet<string>): string | null {
  const host = [...hostsOf(line)].find((name) => !known.has(name) && !/\.(md|ts|js|json|py|txt)$/.test(name))
  if (host !== undefined) {
    return `names a new host, ${host}`
  }
  if (PIPE_TO_SHELL.test(line)) {
    return 'pipes into an interpreter'
  }
  return COMMANDING.test(line) ? 'reads as a command' : null
}

/**
 * Seti's own found lines for a memory file a dream changed: each added line that names a host
 * the file did not, pipes into an interpreter, or tells the agent to ignore rules, always run or
 * never tell. A tripwire, not a filter: it says where to look, and the file can be undone.
 */
export function tripwire(file: string, before: string, after: string): string[] {
  const known = hostsOf(before)
  return addedLines(before, after).flatMap((line) => {
    const reason = why(line, known)
    const shown = redactSecrets(line.trim()).slice(0, SHOWN)
    return reason === null ? [] : [`Seti: ${file} gained a line that ${reason}: "${shown}"`]
  })
}

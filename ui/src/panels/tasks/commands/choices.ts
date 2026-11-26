import type { Choice, CommandStep } from './types'

export const choice = (args: string, label: string, current = false, detail: string | null = null): Choice => ({
  args,
  label,
  detail,
  current,
})

const words = (item: Choice) => [item.args.toLowerCase(), item.label.toLowerCase()]

/** The choice the typed words name: exactly, else as the only one they start. */
export function matchChoice(choices: readonly Choice[], typed: string): Choice | null {
  const query = typed.trim().toLowerCase()
  if (query === '') {
    return null
  }
  const exact = choices.find((item) => words(item).includes(query))
  if (exact !== undefined) {
    return exact
  }
  const started = choices.filter((item) => words(item).some((word) => word.startsWith(query)))
  return started.length === 1 ? (started[0] ?? null) : null
}

/** The choices the typed words start, or all of them when they start none. */
function narrowed(choices: readonly Choice[], typed: string): readonly Choice[] {
  const query = typed.trim().toLowerCase()
  const started = choices.filter((item) => words(item).some((word) => word.startsWith(query)))
  return started.length === 0 ? choices : started
}

/** Offers the choices until the typed words name one, then takes that one's step. */
export function pick(
  prompt: string,
  choices: readonly Choice[],
  typed: string,
  then: (picked: Choice) => CommandStep,
): CommandStep {
  const picked = matchChoice(choices, typed)
  return picked === null ? { kind: 'choose', prompt, choices: narrowed(choices, typed) } : then(picked)
}

/** A step that does something at once and reports whether it worked. */
export const runStep = (run: () => Promise<boolean>): CommandStep => ({ kind: 'run', run })

export const refuse = (reason: string): CommandStep => ({ kind: 'refuse', reason })

/** The first word and the rest of the typed arguments. */
export function splitFirst(args: string): [string, string] {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  return space === -1 ? [trimmed, ''] : [trimmed.slice(0, space), trimmed.slice(space).trim()]
}

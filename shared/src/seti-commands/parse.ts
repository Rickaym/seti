import { describeSetiCommand } from './describe.js'
import { SETI_LINE_MAX } from './limits.js'
import { isSetiLine } from './names.js'
import { SETI_PREFIX, type OpRule } from './rules.js'
import { stepAt } from './steps.js'
import type { CommandOption, CommandWorld, GrammarStep } from './world.js'

export { SETI_LINE_MAX } from './limits.js'

/** A line Seti understood: what it changes, who may run it, and the words to show for it. */
export interface SetiCommand {
  /** The command's name, then each word as the command holds it, such as an item's id. */
  keys: readonly string[]
  /** The line in its canonical form, `/seti:access mcp playwright on`. */
  line: string
  /** What it does, in Seti's words. */
  description: string
  rule: OpRule
}

export type SetiParse = { ok: true; command: SetiCommand } | { ok: false; reason: string }

const fail = (reason: string): SetiParse => ({ ok: false, reason })

// eslint-disable-next-line no-control-regex -- a command line must hold no control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/

/** Why the text cannot be a command line at all; null when its words can be read. */
function shapeRefusal(text: string): string | null {
  if (text.length > SETI_LINE_MAX) {
    return `A Seti command is at most ${String(SETI_LINE_MAX)} characters`
  }
  if (/[\r\n]/.test(text.trim())) {
    return 'A Seti command is one line'
  }
  if (CONTROL.test(text.trim())) {
    return 'A Seti command holds no control or invisible characters'
  }
  return isSetiLine(text) ? null : `A Seti command starts with /${SETI_PREFIX}`
}

/** The words of a line, its leading slash dropped. */
const wordsOf = (text: string) => text.trim().slice(1).split(/\s+/)

type Choose = Extract<GrammarStep, { kind: 'choose' }>

type Got<T> = { ok: true; value: T } | { ok: false; reason: string }
const got = <T>(value: T): Got<T> => ({ ok: true, value })
const refused = <T>(reason: string): Got<T> => ({ ok: false, reason })

/** The option a word picks: its token, key or label, in any case; one match or none. */
function match(step: Choose, word: string): Got<CommandOption> {
  const lower = word.toLowerCase()
  const same = (value: string) => value.toLowerCase() === lower
  const exact = step.options.filter((entry) => entry.token === word || entry.key === word)
  const loose = step.options.filter((entry) => same(entry.token) || same(entry.key) || same(entry.label))
  const found = exact.length === 1 ? exact : loose
  if (found.length > 1) {
    return refused(`${word} is more than one ${step.prompt}; use its id`)
  }
  const picked = found[0]
  if (picked !== undefined) {
    return got(picked)
  }
  if (step.free === null) {
    return refused(`Expected ${step.prompt}, not ${word}`)
  }
  const free = step.free(word)
  return 'option' in free ? got(free.option) : refused(free.refusal)
}

interface Walked {
  keys: string[]
  shown: string[]
  rule: OpRule | null
}

/** Matches each word against the grammar; a refusal, or the keys and the rule the line ends with. */
function walk(words: readonly string[], world: CommandWorld): Got<Walked> {
  const walked: Walked = { keys: [], shown: [], rule: null }
  for (const [index, word] of words.entries()) {
    const step = stepAt(walked.keys, world)
    if (step === null || step.kind === 'end') {
      return refused(`/${walked.shown.join(' ')} takes nothing after it`)
    }
    if (step.kind === 'rest') {
      const rest = words.slice(index).join(' ')
      return rest.length > step.max
        ? refused(`Keep ${step.prompt} under ${String(step.max)} characters`)
        : got({ keys: [...walked.keys, rest], shown: [...walked.shown, rest], rule: step.rule })
    }
    const picked = match(step, word)
    if (!picked.ok) {
      return picked
    }
    if (picked.value.unavailable !== null) {
      return refused(picked.value.unavailable)
    }
    walked.keys.push(picked.value.key)
    walked.shown.push(picked.value.token)
  }
  return got(walked)
}

/** The rule the line ends with, or what it still needs. */
function endRule(walked: Walked, world: CommandWorld): Got<OpRule> {
  if (walked.rule !== null) {
    return got(walked.rule)
  }
  const step = stepAt(walked.keys, world)
  if (step?.kind === 'end') {
    return got(step.rule)
  }
  if (step?.kind === 'choose' && step.endRule !== null) {
    return got(step.endRule)
  }
  const prompt = step === null ? 'more' : step.prompt
  return refused(`/${walked.shown.join(' ')} needs ${prompt}`)
}

/**
 * Reads a Seti command line against the agent's state, for the user at the reply box or for an
 * agent's proposal: one parser for both, so a proposal can say only what the grammar defines.
 */
export function parseSetiLine(text: string, world: CommandWorld): SetiParse {
  const shape = shapeRefusal(text)
  if (shape !== null) {
    return fail(shape)
  }
  const walked = walk(wordsOf(text), world)
  if (!walked.ok) {
    return fail(walked.reason)
  }
  const { keys, shown } = walked.value
  const rule = endRule(walked.value, world)
  if (!rule.ok) {
    return fail(rule.reason)
  }
  const description = describeSetiCommand(keys, world)
  return { ok: true, command: { keys, line: `/${shown.join(' ')}`, rule: rule.value, description } }
}

/** What the menu offers for the word being typed, and where in the text that word starts. */
export interface SetiCompletion {
  prompt: string
  options: readonly CommandOption[]
  from: number
}

/** A bare name offers the Seti command it matches: `/acc` offers `/seti:access`. */
const namePrefix = (word: string) =>
  word.toLowerCase().startsWith(SETI_PREFIX) ? word.slice(SETI_PREFIX.length) : word

/**
 * The choices for the last word of a draft that starts with a slash, the same on every surface;
 * null when the draft is not a command Seti can complete.
 */
export function completeSetiLine(text: string, world: CommandWorld): SetiCompletion | null {
  if (!text.startsWith('/') || /[\r\n]/.test(text) || text.length > SETI_LINE_MAX) {
    return null
  }
  const words = text.slice(1).split(/\s+/)
  const partial = words.pop() ?? ''
  const result = walk(words, world)
  if (!result.ok || result.value.rule !== null) {
    return null
  }
  const walked = result.value
  const step = stepAt(walked.keys, world)
  if (step?.kind !== 'choose') {
    return null
  }
  const typed = (walked.keys.length === 0 ? namePrefix(partial) : partial).toLowerCase()
  const fits = (entry: CommandOption) =>
    walked.keys.length === 0
      ? entry.key.startsWith(typed)
      : entry.token.toLowerCase().startsWith(typed) || entry.label.toLowerCase().startsWith(typed)
  return { prompt: step.prompt, options: step.options.filter(fits), from: text.length - partial.length }
}

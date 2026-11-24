import {
  RUNTIME_NAMES,
  SECOND_OPINION_LIMITS as LIMITS,
  type RuntimeOffer,
  type SecondOpinionInput,
  type StoredRuntime,
  type Task,
} from '@seti/shared'
import { requireRuntime } from '../codex-status.js'
import { readSendable } from '../file-handoff.js'
import { HttpError } from '../http.js'
import { everyOffer } from '../runtime-offers.js'
import { redactCredentials, redactSecrets } from '../scrub.js'
import { teamMessages } from '../store/team.js'

/** A direct team message this long or longer may not appear in what an agent sends out. */
const QUOTED_MIN = 40

/** Direct messages the agent sees, of which the newest are checked. */
const DIRECT_CHECKED = 200

const refuse = (text: string) => new HttpError(409, text)

const clean = (text: string) => redactSecrets(redactCredentials(text))

/** Which runtime and model answer a second opinion. */
export interface Answerer {
  runtime: StoredRuntime
  model: string
}

/** Why a runtime cannot answer for the agent now, or null when it can. */
async function unready(runtime: StoredRuntime, caller: Task): Promise<string | null> {
  try {
    await requireRuntime(runtime, caller.profile_id)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function modelOf(offer: RuntimeOffer, named: string | undefined): string {
  const first = offer.models[0]?.id
  if (named === undefined && first !== undefined) {
    return first
  }
  if (named !== undefined && offer.models.some((each) => each.id === named)) {
    return named
  }
  const offered = offer.models.map((each) => each.id).join(', ')
  throw refuse(`${RUNTIME_NAMES[offer.runtime]} offers no model ${String(named)}; it offers ${offered}.`)
}

/**
 * The runtime and model that answer: the ones named, or else the first runtime in the order Seti
 * offers them that is not the caller's and can answer for its credential, with its first model.
 */
export async function answererFor(caller: Task, input: SecondOpinionInput): Promise<Answerer> {
  const offers = everyOffer()
  if (input.runtime !== undefined) {
    const named = offers.find((offer) => offer.runtime === input.runtime)
    const why = named === undefined ? 'it is not set up' : await unready(named.runtime, caller)
    if (named === undefined || why !== null) {
      throw refuse(`${RUNTIME_NAMES[input.runtime]} cannot give a second opinion now: ${String(why)}.`)
    }
    return { runtime: named.runtime, model: modelOf(named, input.model) }
  }
  const reasons: string[] = []
  for (const offer of offers.filter((each) => each.runtime !== caller.runtime)) {
    const why = await unready(offer.runtime, caller)
    if (why === null) {
      return { runtime: offer.runtime, model: modelOf(offer, input.model) }
    }
    reasons.push(`${RUNTIME_NAMES[offer.runtime]}: ${why}`)
  }
  const detail = reasons.length === 0 ? 'no other runtime is set up' : reasons.join('; ')
  throw refuse(`No other runtime can give a second opinion now (${detail}).`)
}

/** Refuses text quoting a direct team message the agent sees, which stays between its two ends. */
async function refuseDirectQuotes(caller: Task, sent: string): Promise<void> {
  const seen = await teamMessages.list({ kind: 'task', taskId: caller.id }, DIRECT_CHECKED)
  const quoted = seen.some(
    (message) =>
      message.to_kind !== null && message.text.trim().length >= QUOTED_MIN && sent.includes(message.text.trim()),
  )
  if (quoted) {
    throw refuse('This quotes a direct team message, which stays between its sender and recipient; leave it out.')
  }
}

/** What a second opinion sends, and its sizes for the audit. */
export interface OpinionPrompt {
  text: string
  sizes: { question: number; context: number; files: number; fileChars: number }
}

const block = (tag: string, body: string, attrs = '') => `<${tag}${attrs}>\n${body}\n</${tag}>`

/**
 * The prompt of a second opinion: the question, the context and the files the agent named, read
 * under send_file's checks and cut to the limits, every part redacted. Refused when it quotes a
 * direct team message.
 */
export async function opinionPrompt(caller: Task, input: SecondOpinionInput): Promise<OpinionPrompt> {
  const files = await readSendable(caller, input.files ?? [], LIMITS.fileChars)
  let room: number = LIMITS.fileChars
  const parts = [block('question', input.question)]
  if (input.context !== undefined && input.context.trim() !== '') {
    parts.push(block('context', input.context))
  }
  let fileChars = 0
  for (const file of files) {
    const text = file.text.slice(0, Math.max(0, room))
    room -= text.length
    fileChars += text.length
    const cut = file.cut || text.length < file.text.length ? '\n[... cut]' : ''
    parts.push(block('file', `${text}${cut}`, ` path="${file.path.replaceAll('"', '')}"`))
  }
  const raw = parts.join('\n\n')
  await refuseDirectQuotes(caller, raw)
  return {
    text: clean(raw),
    sizes: {
      question: input.question.length,
      context: input.context?.length ?? 0,
      files: files.length,
      fileChars,
    },
  }
}

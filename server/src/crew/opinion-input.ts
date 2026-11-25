import {
  PR_REVIEW_QUESTION,
  RUNTIME_NAMES,
  SECOND_OPINION_LIMITS as LIMITS,
  type RuntimeOffer,
  type SecondOpinionInput,
  type StoredRuntime,
  type Task,
} from '@seti/shared'
import { requireRuntime } from '../codex-status.js'
import { readSendable } from '../file-handoff.js'
import { gh } from '../github.js'
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
  /** The pull request whose diff it holds, if any. */
  pr: string | null
  sizes: { question: number; context: number; files: number; fileChars: number; diff: number }
}

const block = (tag: string, body: string, attrs = '') => `<${tag}${attrs}>\n${body}\n</${tag}>`

const CUT = '\n[... cut]'

/** The agent's files as blocks, cut to share the files limit, and how many characters they hold. */
async function fileBlocks(caller: Task, raws: readonly string[]): Promise<{ parts: string[]; chars: number }> {
  const files = await readSendable(caller, raws, LIMITS.fileChars)
  let room: number = LIMITS.fileChars
  const parts = files.map((file) => {
    const text = file.text.slice(0, Math.max(0, room))
    room -= text.length
    const cut = file.cut || text.length < file.text.length ? CUT : ''
    return block('file', `${text}${cut}`, ` path="${file.path.replaceAll('"', '')}"`)
  })
  return { parts, chars: LIMITS.fileChars - room }
}

/**
 * The diff of one of the agent's linked pull requests, read with the host's GitHub login and cut
 * to the context limit; refused for a PR the agent is not linked to.
 */
async function prDiff(caller: Task, url: string): Promise<string> {
  if (!caller.pr_urls.includes(url)) {
    throw refuse(`${url} is not linked to you; link it first, or review only your own pull requests.`)
  }
  const diff = await gh(['pr', 'diff', url, '--color', 'never']).catch((e: unknown) => {
    throw refuse(`GitHub gave no diff for ${url}: ${e instanceof Error ? e.message : String(e)}`)
  })
  return diff.length <= LIMITS.context ? diff : `${diff.slice(0, LIMITS.context)}${CUT}`
}

/**
 * The prompt of a second opinion: the question, the context, the files the agent named, read
 * under send_file's checks, and the diff of a linked PR, cut to the limits and every part
 * redacted. Refused when it quotes a direct team message.
 */
export async function opinionPrompt(caller: Task, input: SecondOpinionInput): Promise<OpinionPrompt> {
  const question = input.question ?? PR_REVIEW_QUESTION
  const parts = [block('question', question)]
  if (input.context !== undefined && input.context.trim() !== '') {
    parts.push(block('context', input.context))
  }
  const files = await fileBlocks(caller, input.files ?? [])
  parts.push(...files.parts)
  const diff = input.pr === undefined ? '' : await prDiff(caller, input.pr)
  if (input.pr !== undefined) {
    parts.push(block('pull-request-diff', diff, ` url="${input.pr.replaceAll('"', '')}"`))
  }
  const raw = parts.join('\n\n')
  await refuseDirectQuotes(caller, raw)
  return {
    text: clean(raw),
    pr: input.pr ?? null,
    sizes: {
      question: question.length,
      context: input.context?.length ?? 0,
      files: files.parts.length,
      fileChars: files.chars,
      diff: diff.length,
    },
  }
}

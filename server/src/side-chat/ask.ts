import { randomUUID } from 'node:crypto'
import type { SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SideAnswer, SideChatEvent, SideChatInput, Task } from '@seti/shared'
import { refuseArchived } from '../archive-guard.js'
import { CLAUDE_HOME } from '../config.js'
import { now } from '../db.js'
import { refuseOtherAgent } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { sessionState } from '../runner.js'
import { redactSecrets } from '../scrub.js'
import { startQuery } from '../sdk-query.js'
import { moveSessionTo } from '../session-files.js'
import { addSideChatCost } from '../store/cost.js'
import { rewinds } from '../store/rewinds.js'
import { requireTask } from '../tasks.js'
import { AnswerStream } from './answer.js'
import { done, followUp, openChat, type SideChat } from './chats.js'
import { promptOf, storeAside } from './history.js'
import { sideChatOptions, type ForkPoint } from './options.js'
import { savedTotal, sessionFile } from './saved-cost.js'
import { refuseHiddenDirect } from '../direct-privacy.js'

/** Longest an answer may take before its fork is stopped. */
const ANSWER_MS = 5 * 60_000
const ERROR_CHARS = 300

type Emit = (event: SideChatEvent) => Promise<void>

/** A question checked and its chat open, ready to be answered with `run`. */
export interface Ask {
  chatId: string
  run: (emit: Emit, signal?: AbortSignal) => Promise<void>
}

const NO_CONVERSATION = 'This agent has no conversation to ask about yet'

/** The agent's conversation as its next turn sees it: the session, or a pending rewind point. */
async function forkPoint(task: Task): Promise<ForkPoint> {
  const pending = await rewinds.pending(task.id)
  if (task.session_id === null || pending?.resume_at === null) {
    throw new HttpError(409, NO_CONVERSATION)
  }
  return { session_id: task.session_id, at: pending?.resume_at ?? null }
}

async function* once(text: string): AsyncGenerator<SDKUserMessage> {
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  }
  yield await Promise.resolve(message)
}

const clipped = (text: string) => {
  const clean = redactSecrets(text.trim())
  return clean.length > ERROR_CHARS ? `${clean.slice(0, ERROR_CHARS - 3)}...` : clean
}

function failureOf(m: SDKResultMessage): string | null {
  if (m.subtype === 'success' && !m.is_error) {
    return null
  }
  if (m.subtype === 'error_max_turns') {
    return 'The side chat ran out of steps before it answered'
  }
  const said = m.subtype === 'success' ? m.result : m.errors.join('; ')
  return said.trim() === '' ? `The side chat stopped: ${m.subtype}` : clipped(said)
}

/**
 * A result no model turn made before the answer began: a resumed session first closes the
 * background task notices it was left with, and the question is answered in the turn after.
 */
const isWaitingNotice = (m: SDKResultMessage, stream: AnswerStream) => m.num_turns === 0 && stream.text === ''

interface Outcome {
  text: string
  cost: number | null
  error: string | null
}

/** What the fork spent: its total less the total it started from, which the session file saved. */
async function countCost(task: Task, m: SDKResultMessage, startedFrom: number): Promise<number | null> {
  const spent = m.total_cost_usd - startedFrom
  if (!Number.isFinite(spent) || spent <= 0) {
    return null
  }
  await addSideChatCost(task.id, spent)
  return spent
}

/** Forks the agent's session for one question and follows the fork to its result. */
async function runFork(task: Task, fork: ForkPoint, prompt: string, run: Running): Promise<Outcome> {
  if (!sessionState(task.id).open) {
    moveSessionTo(CLAUDE_HOME, fork.session_id, task.cwd)
  }
  const file = sessionFile(fork.session_id, task.cwd)
  const saved = savedTotal(file)
  const options = await sideChatOptions(task, fork, { reads: run.reads, abortController: run.abort })
  const query = startQuery({ prompt: once(prompt), options })
  const stream = new AnswerStream()
  const outcome = async (m: SDKResultMessage): Promise<Outcome> => {
    const cost = await countCost(task, m, Math.max(saved, savedTotal(file)))
    return { text: stream.text, cost, error: failureOf(m) }
  }
  let skipped: SDKResultMessage | null = null
  try {
    for await (const m of query) {
      if (m.type === 'result' && isWaitingNotice(m, stream)) {
        skipped = m
      } else if (m.type === 'result') {
        return await outcome(m)
      } else {
        const event = stream.next(m)
        if (event !== null) {
          await run.emit(event)
        }
      }
    }
    if (skipped !== null) {
      return await outcome(skipped)
    }
    return { text: stream.text, cost: null, error: 'The side chat ended without an answer' }
  } catch (e) {
    const why = run.abort.signal.aborted ? 'The side chat was closed' : `The side chat stopped: ${String(e)}`
    return { text: stream.text, cost: null, error: clipped(why) }
  } finally {
    query.close()
  }
}

interface Running {
  chat: SideChat
  reads: boolean
  abort: AbortController
  emit: Emit
}

/** Answers one question of the chat, streaming the answer, and stores it as an aside. */
async function answer(task: Task, question: string, run: Running): Promise<void> {
  const fork = await forkPoint(task)
  const askedAt = now()
  await run.emit({ type: 'start', chat_id: run.chat.id })
  const outcome = await runFork(task, fork, await promptOf(task.id, run.chat.id, question), run)
  if (outcome.error !== null) {
    await run.emit({ type: 'error', error: outcome.error })
    return
  }
  const text = redactSecrets(outcome.text)
  const stored = await storeAside({
    taskId: task.id,
    chatId: run.chat.id,
    question,
    answer: text,
    costUsd: outcome.cost,
    askedAt,
  })
  done(run.chat)
  await run.emit({ type: 'done', text, cost_usd: outcome.cost, aside: stored })
}

/**
 * Checks a side chat question and opens its chat, or takes up a stored one for a follow-up.
 * Agents asking through their Seti tools get no tools in the fork, so they reach nothing more.
 */
export async function prepareAsk(taskId: string, input: SideChatInput, reads: boolean): Promise<Ask> {
  const task = await requireTask(taskId)
  refuseArchived(task)
  await refuseHiddenDirect(task.id)
  await forkPoint(task)
  const chat = input.chat_id === undefined ? await openChat(task, reads) : await followUp(task.id, input.chat_id)
  const { abort } = chat
  const run = async (emit: Emit, signal?: AbortSignal) => {
    const stop = () => {
      abort.abort()
    }
    signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, ANSWER_MS)
    try {
      await answer(task, input.question.trim(), { chat, reads, abort, emit })
    } catch (e) {
      await emit({ type: 'error', error: clipped(e instanceof Error ? e.message : String(e)) })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      done(chat)
    }
  }
  return { chatId: chat.id, run }
}

/** Asks a one-off side question in a chat of its own and returns the whole answer. */
export async function askAside(taskId: string, question: string, reads: boolean): Promise<SideAnswer> {
  refuseOtherAgent(taskId)
  const ask = await prepareAsk(taskId, { question }, reads)
  const got: { answer: SideAnswer | null; error: string } = {
    answer: null,
    error: 'The side chat ended without an answer',
  }
  await ask.run(async (event) => {
    if (event.type === 'done') {
      got.answer = { answer: event.text, cost_usd: event.cost_usd }
    } else if (event.type === 'error') {
      got.error = event.error
    }
    return Promise.resolve()
  })
  if (got.answer === null) {
    throw new HttpError(502, got.error)
  }
  return got.answer
}

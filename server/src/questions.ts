import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  isYesNo,
  QUESTION_DESCRIPTION_MAX,
  QUESTION_HEADER_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_PROMPT_MAX,
  type Question,
  type QuestionOption,
} from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { redactSecrets } from './scrub.js'
import { questions, type NewQuestion } from './store/questions.js'
import { refreshBlocked } from './task-blocked.js'

/** Claude Code's tool for asking the user questions, which Seti holds until they are answered. */
export const ASK_TOOL = 'AskUserQuestion'

const QUESTIONS_MAX = 4

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** One question of the tool's input, as far as Seti shows it. */
interface AskedQuestion {
  header: string
  prompt: string
  multi: boolean
  options: QuestionOption[]
}

function optionOf(value: unknown): QuestionOption | null {
  const label = isRecord(value) ? textOf(value.label) : ''
  if (label === '' || !isRecord(value)) {
    return null
  }
  const description = textOf(value.description)
  return {
    label: clip(label, QUESTION_LABEL_MAX),
    description: description === '' ? null : clip(redactSecrets(description), QUESTION_DESCRIPTION_MAX),
  }
}

function questionOf(value: unknown): AskedQuestion | null {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    return null
  }
  const prompt = textOf(value.question)
  const options = value.options.map(optionOf)
  if (prompt === '' || options.length === 0 || options.length > QUESTION_OPTIONS_MAX || options.includes(null)) {
    return null
  }
  const header = textOf(value.header)
  return {
    header: clip(redactSecrets(header === '' ? prompt : header), QUESTION_HEADER_MAX),
    prompt: clip(redactSecrets(prompt), QUESTION_PROMPT_MAX),
    multi: value.multiSelect === true,
    options: options.filter((option) => option !== null),
  }
}

/** The questions of an AskUserQuestion call, or null when its input does not hold any. */
function askedQuestions(input: Record<string, unknown>): AskedQuestion[] | null {
  const list = input.questions
  if (!Array.isArray(list) || list.length === 0 || list.length > QUESTIONS_MAX) {
    return null
  }
  const asked = list.map(questionOf)
  return asked.includes(null) ? null : asked.filter((question) => question !== null)
}

const BAD_INPUT: PermissionResult = {
  behavior: 'deny',
  message: 'AskUserQuestion needs one to four questions, each with a question and two to four labelled options.',
}

const EXPIRED: PermissionResult = { behavior: 'deny', message: 'The questions were dropped.', interrupt: true }

/** A call waiting for its answers: the input to hand back and how to resume the agent. */
interface Waiter {
  taskId: string
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

/** Calls waiting for the user, by question group. */
const waiting = new Map<string, Waiter>()

/** The waiting call of the group, or undefined when no session waits on it any more. */
export const waiterOf = (groupId: string): Waiter | undefined => waiting.get(groupId)

/** Hands the agent its result; false when no session waits on the group any more. */
export function resumeGroup(groupId: string, result: PermissionResult): boolean {
  const waiter = waiting.get(groupId)
  waiting.delete(groupId)
  waiter?.resolve(result)
  return waiter !== undefined
}

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`

async function titleOf(taskId: string): Promise<string> {
  return (await tasks.get(taskId))?.title ?? taskId
}

/** Expires the group's open questions and records it; the reason says why the agent stopped. */
export async function expireGroup(groupId: string, reason: string): Promise<Question[]> {
  waiting.delete(groupId)
  const expired = await questions.expireGroup(groupId)
  const [first] = expired
  if (first !== undefined) {
    await audit.record({
      actor: 'system',
      kind: 'task.question_expired',
      subject_type: 'task',
      subject_id: first.task_id,
      summary: `${plural(expired.length, 'question')} of task "${first.task_title}" expired: ${reason}`,
      detail: { title: first.task_title, group_id: groupId, questions: expired.length, reason },
    })
    await refreshBlocked(first.task_id)
  }
  return expired
}

/** Waits for the group's answers, from before it is recorded; a stopped turn expires it. */
async function answersOf(groupId: string, waiter: Omit<Waiter, 'resolve'>, signals: readonly AbortSignal[]) {
  const signal = AbortSignal.any([...signals])
  return new Promise<PermissionResult>((resolve) => {
    const drop = () => {
      if (!waiting.has(groupId)) {
        return
      }
      expireGroup(groupId, 'the agent stopped waiting')
        .catch((e: unknown) => {
          process.stderr.write(`questions: could not expire group ${groupId}: ${String(e)}\n`)
        })
        .finally(() => {
          resolve(EXPIRED)
        })
    }
    waiting.set(groupId, {
      ...waiter,
      resolve: (result) => {
        signal.removeEventListener('abort', drop)
        resolve(result)
      },
    })
    if (signal.aborted) {
      drop()
    } else {
      signal.addEventListener('abort', drop, { once: true })
    }
  })
}

type AskOptions = Parameters<CanUseTool>[2]

function newRows(taskId: string, groupId: string, asked: readonly AskedQuestion[], options: AskOptions) {
  return asked.map((question, position): NewQuestion => ({
    id: randomUUID(),
    group_id: groupId,
    task_id: taskId,
    subagent_id: options.agentID ?? null,
    tool_use_id: options.toolUseID,
    position,
    header: question.header,
    prompt: question.prompt,
    kind: isYesNo(question.options) && !question.multi ? 'yes_no' : 'choice',
    multi: question.multi,
    options: question.options,
  }))
}

async function auditAsked(taskId: string, stored: readonly Question[]): Promise<void> {
  const title = await titleOf(taskId)
  await audit.record({
    actor: 'agent',
    kind: 'task.question_asked',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Task "${title}" asked ${plural(stored.length, 'question')}`,
    detail: {
      title,
      group_id: stored[0]?.group_id ?? null,
      questions: stored.length,
      headers: stored.map((question) => question.header),
      kinds: stored.map((question) => (question.multi ? 'choice_multi' : question.kind)),
    },
  })
}

/** Records an AskUserQuestion call as a group of questions and holds it until they are settled. */
export async function askQuestions(
  taskId: string,
  input: Record<string, unknown>,
  options: AskOptions,
  session: AbortSignal,
): Promise<PermissionResult> {
  const asked = askedQuestions(input)
  if (asked === null) {
    return BAD_INPUT
  }
  const groupId = randomUUID()
  const answer = answersOf(groupId, { taskId, input }, [options.signal, session])
  try {
    const stored = await questions.open(newRows(taskId, groupId, asked, options))
    await auditAsked(taskId, stored)
    if (waiting.has(groupId)) {
      await refreshBlocked(taskId)
    } else {
      await expireGroup(groupId, 'the agent stopped waiting')
    }
    return await answer
  } finally {
    waiting.delete(groupId)
  }
}

/** No process waits on a question a restart left open; startup expires them. */
export async function expireLeftoverQuestions(): Promise<void> {
  const expired = await questions.expireAll()
  if (expired.length > 0) {
    await audit.record({
      actor: 'system',
      kind: 'task.question_expired',
      subject_type: 'system',
      summary: `Expired ${plural(expired.length, 'question')} a restart cut off`,
      detail: { questions: expired.length, reason: 'restart' },
    })
  }
}

const ASKING =
  'When you need the user to decide or tell you something before you can go on, ask with the ' +
  'AskUserQuestion tool instead of writing the question in your reply. Seti collects every ' +
  "agent's questions in one Questions view; your call waits there and its result carries the " +
  'answers. Give each question two to four short options, since the user can always answer in ' +
  'their own words instead; for a yes or no question make the options exactly Yes and No. Ask ' +
  'related questions together, up to four in one call. Write a question in your reply only when ' +
  'you have finished the work and are only offering a next step. If you recommend an option, put ' +
  'it first and end its label with (Recommended); Seti picks it for the user to confirm. To ask the ' +
  'user for a secret, token or password, use ask_secret; never ask for one in your reply or with ' +
  'AskUserQuestion.'

/** Tells every agent to ask the user through AskUserQuestion, which Seti collects. */
export const questionsContext = (): string => ASKING

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  answerText,
  type AnswerQuestionsInput,
  type AnswerQuestionsResult,
  type Question,
  type QuestionAnswer,
  type QuestionAnswerer,
  type QuestionAnswerItem,
} from '@seti/shared'
import { audit } from './audit.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { expireGroup, resumeGroup, waiterOf } from './questions.js'
import { credentialFindings } from './scrub.js'
import { questions } from './store/questions.js'
import { refreshBlocked } from './task-blocked.js'

/** The refusal of an answer that holds a secret, which goes through the user's Allow instead. */
export const SECRET_ANSWER =
  'That answer looks like a secret or credential, which questions never carry. Add it in Settings, ' +
  'Credentials, and approve the connection the agent asks for with its change request.'

const DISMISSED_ONE = 'The user dismissed this question without answering. Decide yourself and say what you assumed.'

const DISMISSED_ALL: PermissionResult = {
  behavior: 'deny',
  message:
    'The user dismissed your questions without answering. Go on with your best judgment and say what you ' +
    'assumed, or end your turn if you cannot go on without an answer.',
}

const named = (question: Question) => `"${question.header}"`

/** Why the answer does not fit the question, or null when it does. */
function answerProblem(question: Question, item: Extract<QuestionAnswerItem, { action: 'answer' }>): string | null {
  const labels = new Set(question.options.map((option) => option.label))
  const unknown = item.selected.find((label) => !labels.has(label))
  if (unknown !== undefined) {
    return `${named(question)} has no option "${unknown}"`
  }
  const picks = new Set(item.selected).size + (item.other === null ? 0 : 1)
  if (picks === 0) {
    return `${named(question)} has no answer; pick an option or write one`
  }
  if (!question.multi && picks > 1) {
    return `${named(question)} takes one answer`
  }
  return null
}

function checkItem(question: Question, item: QuestionAnswerItem): void {
  if (item.action === 'dismiss') {
    return
  }
  const problem = answerProblem(question, item)
  if (problem !== null) {
    throw new HttpError(400, problem)
  }
  if (item.other !== null && credentialFindings(item.other).length > 0) {
    throw new HttpError(422, SECRET_ANSWER)
  }
}

const answerOf = (item: Extract<QuestionAnswerItem, { action: 'answer' }>): QuestionAnswer => ({
  selected: [...new Set(item.selected)],
  other: item.other,
})

async function auditSettled(question: Question, by: QuestionAnswerer): Promise<void> {
  const answered = question.status === 'answered' && question.answer !== null
  const relayed = by === 'ea' ? ' through the EA' : ''
  await audit.record({
    actor: 'user',
    kind: answered ? 'task.question_answered' : 'task.question_dismissed',
    subject_type: 'task',
    subject_id: question.task_id,
    summary: `${answered ? 'Answered' : 'Dismissed'} question "${question.header}" of task "${question.task_title}"${relayed}`,
    detail: {
      title: question.task_title,
      question_id: question.id,
      group_id: question.group_id,
      by,
      kind: question.multi ? 'choice_multi' : question.kind,
      selected: question.answer?.selected ?? [],
      own_words_chars: question.answer?.other?.length ?? 0,
    },
  })
}

/** What Claude Code reads for one settled question: picked labels and own words, or why none. */
function answerValue(question: Question): string[] {
  if (question.answer === null) {
    return [DISMISSED_ONE]
  }
  const { selected, other } = question.answer
  const words = other === null ? [] : [other]
  return question.multi ? [...selected, ...words] : [other ?? answerText(question.answer)]
}

/**
 * The tool result of a settled group: AskUserQuestion's own input with `answers` keyed by each
 * question's text, as Claude Code reads it; a group the user only dismissed is turned down.
 */
function groupResult(group: readonly Question[], input: Record<string, unknown>): PermissionResult {
  if (group.every((question) => question.status === 'dismissed')) {
    return DISMISSED_ALL
  }
  const asked = Array.isArray(input.questions) ? (input.questions as unknown[]) : []
  const answers: Record<string, string | string[]> = {}
  for (const question of group) {
    const original = asked[question.position]
    const text =
      typeof original === 'object' && original !== null && 'question' in original ? original.question : undefined
    const value = answerValue(question)
    answers[typeof text === 'string' ? text : question.prompt] =
      question.multi && question.answer !== null ? value : value.join(', ')
  }
  return { behavior: 'allow', updatedInput: { ...input, answers } }
}

/** Hands a group back to its agent once every question in it is settled; true when it did. */
async function deliverGroup(groupId: string): Promise<boolean> {
  const group = await questions.group(groupId)
  if (group.length === 0 || group.some((question) => question.status === 'open')) {
    return false
  }
  if (group.some((question) => question.status === 'expired')) {
    return false
  }
  const waiter = waiterOf(groupId)
  if (waiter === undefined) {
    await expireGroup(groupId, 'no session waits on it')
    return false
  }
  return resumeGroup(groupId, groupResult(group, waiter.input))
}

async function settle(question: Question, item: QuestionAnswerItem, by: QuestionAnswerer) {
  return item.action === 'answer'
    ? questions.answer(question.id, answerOf(item), by)
    : questions.dismiss(question.id, by)
}

/**
 * Answers and dismisses questions in one go, checking every answer before it stores any.
 * Questions that are no longer open are left out. The EA's answers are recorded as relayed;
 * agents and mods never answer for the user.
 */
export async function answerQuestions(input: AnswerQuestionsInput): Promise<AnswerQuestionsResult> {
  refuseAgent("answer the user's questions")
  const by: QuestionAnswerer = fromEa() ? 'ea' : 'user'
  const byId = new Map((await questions.byIds(input.items.map((item) => item.id))).map((q) => [q.id, q]))
  const open = input.items.flatMap((item) => {
    const question = byId.get(item.id)
    return question?.status === 'open' ? [{ question, item }] : []
  })
  for (const { question, item } of open) {
    checkItem(question, item)
  }
  const result: AnswerQuestionsResult = {
    answered: 0,
    dismissed: 0,
    skipped: input.items.length - open.length,
    resumed: [],
  }
  const groups = new Map<string, Question>()
  for (const { question, item } of open) {
    const settled = await settle(question, item, by)
    if (settled === undefined) {
      result.skipped += 1
      continue
    }
    result[settled.status === 'answered' ? 'answered' : 'dismissed'] += 1
    groups.set(settled.group_id, settled)
    await auditSettled(settled, by)
  }
  for (const [groupId, question] of groups) {
    const resumed = await deliverGroup(groupId)
    if (resumed && !result.resumed.some((agent) => agent.task_id === question.task_id)) {
      result.resumed.push({ task_id: question.task_id, task_title: question.task_title })
    }
    await refreshBlocked(question.task_id)
  }
  return result
}

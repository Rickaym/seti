import { randomUUID } from 'node:crypto'
import type { AskSecretInput, Question, QuestionSecret, SupplySecretResult, Task } from '@seti/shared'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { sandboxed } from './aws-access.js'
import { tasks } from './db.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { expireGroup } from './questions.js'
import { redactSecrets } from './scrub.js'
import { secretStoreProblem, storeSecret, suppliedText, writeSecretFile } from './secret-delivery.js'
import { ToolRefusal } from './seti-tools/tool.js'
import { questions } from './store/questions.js'
import { refreshBlocked } from './task-blocked.js'

/** How a secret question ended for the agent that waits on it. */
type Outcome = { kind: 'supplied'; text: string } | { kind: 'dismissed' } | { kind: 'expired' }

/** Agents' ask_secret calls waiting for the user, by question id. */
const waiting = new Map<string, (outcome: Outcome) => void>()

const DISMISSED =
  'The user dismissed your request for the secret without giving it. Go on without it, or end your turn ' +
  'and say what you need it for.'

const EXPIRED = 'Your request for the secret was dropped before the user answered it.'

/** The EA relays answers but never a secret: the user enters each one in Seti. */
const EA_SECRET = 'The EA cannot answer a secret question; the user enters the value in Seti'

/** Waits for the user, from before the question is recorded; an aborted call expires it. */
async function outcomeOf(question: Pick<Question, 'id' | 'group_id'>, signal: AbortSignal | undefined) {
  return new Promise<Outcome>((resolve) => {
    const drop = () => {
      if (!waiting.delete(question.id)) {
        return
      }
      expireGroup(question.group_id, 'the agent stopped waiting')
        .catch((e: unknown) => {
          process.stderr.write(`questions: could not expire secret question ${question.id}: ${String(e)}\n`)
        })
        .finally(() => {
          resolve({ kind: 'expired' })
        })
    }
    waiting.set(question.id, (outcome) => {
      signal?.removeEventListener('abort', drop)
      resolve(outcome)
    })
    if (signal?.aborted === true) {
      drop()
    } else {
      signal?.addEventListener('abort', drop, { once: true })
    }
  })
}

async function auditAsked(task: Task, question: Question, secret: QuestionSecret): Promise<void> {
  await audit.record({
    actor: 'agent',
    kind: 'task.question_asked',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Task "${task.title}" asked for the secret ${secret.name}`,
    detail: {
      title: task.title,
      group_id: question.group_id,
      questions: 1,
      secret: true,
      name: secret.name,
      delivery: secret.delivery,
      hosts: secret.hosts,
    },
  })
}

/** Where the secret goes for this agent, or the refusal the agent gets instead. */
async function secretFor(task: Task, input: AskSecretInput): Promise<QuestionSecret> {
  if (!(await sandboxed(task))) {
    return { name: input.name, hosts: [], delivery: 'file' }
  }
  const problem = await secretStoreProblem(task, input.name, input.hosts)
  if (problem !== null) {
    throw new ToolRefusal(problem)
  }
  return { name: input.name, hosts: input.hosts, delivery: 'secret_store' }
}

/**
 * Records a secret question and holds the agent's ask_secret call until the user supplies the
 * value or dismisses it. The call gets where the secret went, never the value.
 */
export async function askSecret(task: Task, input: AskSecretInput, signal?: AbortSignal): Promise<string> {
  refuseArchived(task)
  const secret = await secretFor(task, input)
  const pending = { id: randomUUID(), group_id: randomUUID() }
  const outcome = outcomeOf(pending, signal)
  try {
    const [stored] = await questions.open([
      {
        ...pending,
        task_id: task.id,
        subagent_id: null,
        tool_use_id: `ask_secret:${pending.id}`,
        position: 0,
        header: secret.name,
        prompt: redactSecrets(input.purpose),
        kind: 'secret',
        multi: false,
        options: [],
        secret,
      },
    ])
    if (stored === undefined) {
      throw new Error('The secret question was not recorded')
    }
    await auditAsked(task, stored, secret)
    await (waiting.has(pending.id)
      ? refreshBlocked(task.id)
      : expireGroup(pending.group_id, 'the agent stopped waiting'))
    const ended = await outcome
    if (ended.kind !== 'supplied') {
      throw new ToolRefusal(ended.kind === 'dismissed' ? DISMISSED : EXPIRED)
    }
    return ended.text
  } finally {
    waiting.delete(pending.id)
  }
}

/** Turns down the waiting call of a dismissed secret question; false when none waits on it. */
export function dismissSecret(questionId: string): boolean {
  const resolve = waiting.get(questionId)
  waiting.delete(questionId)
  resolve?.({ kind: 'dismissed' })
  return resolve !== undefined
}

/** Puts the value where the question says, in memory only; returns the file's path for a file. */
async function deliver(task: Task, secret: QuestionSecret, value: string): Promise<string | null> {
  if (secret.delivery === 'file') {
    return writeSecretFile(task.id, secret.name, value)
  }
  await storeSecret(task, secret, value)
  return null
}

async function auditSupplied(question: Question, secret: QuestionSecret): Promise<void> {
  await audit.record({
    actor: 'user',
    kind: 'task.question_answered',
    subject_type: 'task',
    subject_id: question.task_id,
    summary: `Supplied the secret ${secret.name} to task "${question.task_title}"`,
    detail: {
      title: question.task_title,
      question_id: question.id,
      group_id: question.group_id,
      by: 'user',
      kind: 'secret',
      secret: true,
      supplied: true,
      name: secret.name,
      delivery: secret.delivery,
    },
  })
}

/** The open secret question, or the refusal of one that is gone, settled or not a secret. */
async function openSecret(id: string): Promise<Question & { secret: QuestionSecret }> {
  const [question] = await questions.byIds([id])
  if (question?.kind !== 'secret' || question.secret === null) {
    throw new HttpError(404, 'No secret question with that id')
  }
  if (question.status !== 'open') {
    throw new HttpError(409, 'This question was already settled')
  }
  return { ...question, secret: question.secret }
}

/**
 * The user's value for a secret question: Seti writes it to the agent's secrets file or seals it
 * in the secret store, then the agent's call goes on with where it went. Only the user supplies
 * one; the EA, agents and mods are refused here, whatever route they come by.
 */
export async function supplySecret(id: string, value: string): Promise<SupplySecretResult> {
  refuseAgent('answer a secret question')
  if (fromEa()) {
    throw new HttpError(403, EA_SECRET)
  }
  const question = await openSecret(id)
  const resolve = waiting.get(id)
  if (resolve === undefined) {
    await expireGroup(question.group_id, 'no session waits on it')
    throw new HttpError(409, 'The agent no longer waits on this secret, so Seti kept nothing')
  }
  const task = await tasks.get(question.task_id)
  if (task === undefined) {
    throw new HttpError(404, 'The agent that asked is gone')
  }
  const file = await deliver(task, question.secret, value)
  const settled = await questions.supplied(id)
  if (settled === undefined) {
    throw new HttpError(409, 'This question was already settled')
  }
  await auditSupplied(settled, question.secret)
  waiting.delete(id)
  resolve({ kind: 'supplied', text: suppliedText(question.secret, file) })
  await refreshBlocked(task.id)
  return { task_id: task.id, task_title: task.title }
}

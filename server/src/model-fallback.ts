import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  endsFallback,
  fallbackReason,
  modelFallbackOf,
  modelLabel,
  movesSession,
  type ModelFallback,
  type ModelFallbackMessage,
  type Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { guarded, queueNotice } from './ea-watch.js'
import { modelFallbacks } from './store/model-fallback.js'
import { publish } from './task-events.js'

/** A fallback notice Seti stored already, which a replayed stream repeats; it is not taken twice. */
export async function replayedFallback(taskId: string, m: SDKMessage): Promise<boolean> {
  const uuid = modelFallbackOf(m)?.uuid
  return uuid !== undefined && (await modelFallbacks.stored(taskId, uuid))
}

const fallbackOf = (event: ModelFallbackMessage): ModelFallback => ({
  original_model: event.original_model,
  fallback_model: event.fallback_model,
  category: event.api_refusal_category ?? null,
  request_id: event.request_id,
  at: now(),
})

function summary(task: Task, f: ModelFallback, session: boolean): string {
  const [from, to, why] = [modelLabel(f.original_model), modelLabel(f.fallback_model), fallbackReason(f.category)]
  return session
    ? `Claude Code switched task "${task.title}" from ${from} to ${to} after ${why}`
    : `Claude Code answered one subagent request of task "${task.title}" on ${to} after ${why}`
}

/** Tells the EA, and through its inbox the user, that the agent now runs on the fallback model. */
async function notify(task: Task, f: ModelFallback): Promise<void> {
  const [from, to] = [modelLabel(f.original_model), modelLabel(f.fallback_model)]
  await guarded('a model fallback', async () => {
    await queueNotice(task, {
      event: 'model_fallback',
      title: `${task.title} switched from ${from} to ${to}`,
      body: `Claude Code switched models after ${fallbackReason(f.category)}. Switch back from the agent.`,
      severity: 'warning',
      subject: 'model',
    })
  })
}

/**
 * Records Claude Code's switch to a fallback model after a refusal: audited once per notice, and
 * when it moves the whole session, marked on the task and sent to the EA's inbox.
 */
export async function noteModelFallback(taskId: string, m: SDKMessage): Promise<void> {
  const event = modelFallbackOf(m)
  const task = event === null ? undefined : await tasks.get(taskId)
  if (event === null || task === undefined) {
    return
  }
  const fallback = fallbackOf(event)
  const session = movesSession(event)
  await audit.record({
    actor: 'system',
    kind: 'task.model_fallback',
    subject_type: 'task',
    subject_id: taskId,
    summary: summary(task, fallback, session),
    detail: {
      title: task.title,
      original_model: fallback.original_model,
      fallback_model: fallback.fallback_model,
      category: fallback.category,
      request_id: fallback.request_id,
      scope: session ? 'session' : 'local',
    },
  })
  if (session) {
    await modelFallbacks.set(taskId, fallback)
    publish(taskId, { type: 'model' })
    await notify(task, fallback)
  }
}

/** A session start on a model other than the fallback ends the task's fallback. */
export async function settleModelFallback(taskId: string, model: string): Promise<void> {
  const fallback = (await tasks.get(taskId))?.model_fallback ?? null
  if (fallback !== null && endsFallback(fallback, model) && (await modelFallbacks.clear(taskId))) {
    publish(taskId, { type: 'model' })
  }
}

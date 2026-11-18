import { timedOutMessage, timeoutMinutesOf, type PermissionRequest } from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { tasks } from './db.js'
import { grantOnce } from './permission-grants.js'
import { expireGroup, expireLeftoverSecrets } from './questions.js'
import { BACKGROUND_NOTE } from './restart-resume.js'
import { runTurn } from './runner.js'
import { permissionRequests } from './store/permissions.js'
import { questions } from './store/questions.js'
import { restartCuts } from './store/restart.js'
import { refreshBlocked } from './task-blocked.js'
import { onAnyTaskEvent } from './task-events.js'

/** Question groups a restart left open with no call waiting on them, with their task. */
const lateGroups = new Map<string, string>()
/** Permission requests a restart left pending with no call waiting on them, with their task. */
const lateRequests = new Map<string, string>()

export const isLateGroup = (groupId: string) => lateGroups.has(groupId)
export const isLateRequest = (requestId: string) => lateRequests.has(requestId)

/**
 * Startup keeps what agents asked the user before the restart: questions stay open and permission
 * requests stay pending, and the answer resumes the agent's session with it. Secret questions
 * expire, since their value only ever goes to the call that waited.
 */
export async function keepLeftoverRequests(): Promise<void> {
  await expireLeftoverSecrets()
  for (const question of await questions.openList()) {
    lateGroups.set(question.group_id, question.task_id)
  }
  for (const request of await permissionRequests.orphan()) {
    lateRequests.set(request.id, request.task_id)
  }
}

/** Sends the agent what the user decided while no call of its waited, in its own session. */
async function sendLate(taskId: string, text: string, what: string): Promise<boolean> {
  const cut = await restartCuts.of(taskId)
  await restartCuts.forgetOne(taskId)
  const prompt = cut !== undefined && cut.background > 0 ? `${text} ${BACKGROUND_NOTE}` : text
  try {
    await runTurn(taskId, prompt, { from: 'Seti' })
  } catch (e) {
    process.stderr.write(`resume: task ${taskId}: ${e instanceof Error ? e.message : String(e)}\n`)
    return false
  }
  const title = (await tasks.get(taskId))?.title ?? taskId
  await audit.record({
    actor: 'system',
    kind: 'task.resumed_after_restart',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Resumed task "${title}" with ${what} given after a restart`,
    detail: { title, reason: what, background: cut?.background ?? 0 },
  })
  return true
}

/** Resumes the agent with the answers to a question group a restart left open; true when sent. */
export async function deliverLateAnswers(groupId: string, text: string): Promise<boolean> {
  const taskId = lateGroups.get(groupId)
  lateGroups.delete(groupId)
  return taskId !== undefined && (await sendLate(taskId, text, 'the answers'))
}

const callOf = (request: PermissionRequest) =>
  request.summary === '' ? request.tool_name : `${request.tool_name} (${request.summary})`

const LATE_CALL = "Seti restarted while this call waited for the user's permission, so it never ran:"

/** What the agent reads about a call the user decided on after the restart cut it off. */
function lateDecisionText(request: PermissionRequest): string {
  if (request.timed_out) {
    return `${LATE_CALL} ${callOf(request)}. ${timedOutMessage(timeoutMinutesOf(request))}`
  }
  if (request.state === 'allowed') {
    const again =
      request.tool_name === 'ExitPlanMode'
        ? 'The user has approved your plan since. Call ExitPlanMode again with the same plan, then start on it.'
        : 'The user has allowed it since. Make exactly the same call again if you still need it; it runs ' +
          'without another request.'
    return `${LATE_CALL} ${callOf(request)}. ${again}`
  }
  const said = request.message === null || request.message === '' ? '' : ` and said: ${request.message}`
  return (
    `${LATE_CALL} ${callOf(request)}. The user has denied it since${said}. Do not retry it; go on ` +
    'without it, or ask the user how to go on if you need it.'
  )
}

/**
 * Resumes the agent with the user's decision on a request a restart left pending. An allowed call
 * runs once without a second request when the agent makes it again unchanged.
 */
export async function deliverLateDecision(request: PermissionRequest): Promise<boolean> {
  lateRequests.delete(request.id)
  const hash = await permissionRequests.hashOf(request.id)
  if (request.state === 'allowed' && hash !== null) {
    grantOnce(request.task_id, hash)
  }
  return sendLate(request.task_id, lateDecisionText(request), 'a permission decision')
}

const idsOf = (late: Map<string, string>, taskId: string) =>
  [...late].filter(([, owner]) => owner === taskId).map(([id]) => id)

/** A new turn makes its own requests, so what a restart left open for the agent is dropped. */
async function dropLate(taskId: string): Promise<void> {
  for (const groupId of idsOf(lateGroups, taskId)) {
    lateGroups.delete(groupId)
    await expireGroup(groupId, 'the agent went on without an answer')
  }
  const dropped = idsOf(lateRequests, taskId)
  for (const id of dropped) {
    lateRequests.delete(id)
    await permissionRequests.settle(id, 'cancelled', null)
  }
  if (dropped.length > 0) {
    await audit.record({
      actor: 'system',
      kind: 'task.permission_denied',
      subject_type: 'task',
      subject_id: taskId,
      summary: `Dropped ${String(dropped.length)} permission requests a restart cut off: the agent went on`,
      detail: { requests: dropped.length, reason: 'restart' },
    })
  }
  await restartCuts.release(taskId)
  await refreshBlocked(taskId)
}

/**
 * Task event listener: a turn starting ends what a restart left waiting for the agent, and lets
 * startup resume an agent again that it had stopped resuming.
 */
export function settleLeftoversOnTurnStart(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'status' && event.status === 'running') {
      inBackground(`leftovers: task ${taskId}`, async () => dropLate(taskId))
    }
  })
}

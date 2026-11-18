import {
  timedOutMessage,
  timeoutAt,
  timeoutLabel,
  timeoutMinutesOf,
  timeoutWarnAt,
  type PermissionRequest,
  type PermissionTimeoutInput,
  type PermissionTimeoutSettings,
} from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { announce, dropRequest, resolveRequest, waitsFor } from './permission-requests.js'
import { deliverLateDecision, isLateRequest } from './restart-waits.js'
import { appendMessage } from './runner.js'
import { permissionRequests, timeoutSettings } from './store/permissions.js'
import { refreshBlocked } from './task-blocked.js'
import { onAnyTaskEvent } from './task-events.js'
import { inLane } from './task-lane.js'

type Timer = ReturnType<typeof setTimeout>

/** Each waiting request's timers: the denial, and the reason line's warning before it. */
const timers = new Map<string, { deny: Timer; warn: Timer | null }>()

function disarm(requestId: string): void {
  const armed = timers.get(requestId)
  clearTimeout(armed?.deny)
  clearTimeout(armed?.warn ?? undefined)
  timers.delete(requestId)
}

/** Records the denial in the audit log, then hands it to the agent and notes it in its transcript. */
async function deliverTimeout(request: PermissionRequest): Promise<void> {
  const minutes = timeoutMinutesOf(request)
  const task = await tasks.get(request.task_id)
  const title = task?.title ?? request.task_id
  const within = timeoutLabel(minutes)
  await audit.record({
    actor: 'system',
    kind: 'task.permission_timed_out',
    subject_type: 'task',
    subject_id: request.task_id,
    summary: `Denied ${request.tool_name} for task "${title}": no answer within ${within}`,
    detail: {
      title,
      tool: request.tool_name,
      call: request.summary,
      rules: request.suggestions,
      timeout_minutes: minutes,
      asked_at: request.created_at,
    },
  })
  await resolveRequest(request, { behavior: 'deny', message: timedOutMessage(minutes) })
  if (task?.archived_at === null) {
    const error = `Denied ${request.tool_name}: timed out after ${within} with no answer`
    const payload = { error, timed_out: request.decided_at ?? request.timeout_at ?? request.created_at }
    await inLane(task.id, async () => appendMessage(task.id, { kind: 'seti', payload }))
  }
}

/**
 * Denies the request once its time is up, as the user's Deny would but with no rule and for this
 * request only; one whose session is gone closes without a word. The denial of a request a
 * restart kept resumes its agent, as the user's answer would.
 */
async function timeOut(requestId: string): Promise<void> {
  timers.delete(requestId)
  const late = isLateRequest(requestId)
  if (!late && !waitsFor(requestId)) {
    await dropRequest(requestId)
    return
  }
  const settled = await permissionRequests.timeOut(requestId, new Date().toISOString())
  if (settled === undefined) {
    return
  }
  await deliverTimeout(settled)
  if (late) {
    await deliverLateDecision(settled)
  }
}

/** Sets the request's timers from its stored deadline; one already past it is denied now. */
function arm(request: PermissionRequest): void {
  disarm(request.id)
  if (request.state !== 'pending' || request.timeout_at === null) {
    return
  }
  const now = Date.now()
  const deny = setTimeout(
    () => {
      inBackground(`permission timeout: request ${request.id}`, async () => timeOut(request.id))
    },
    Math.max(0, Date.parse(request.timeout_at) - now),
  ).unref()
  const warnAt = timeoutWarnAt(request)
  const warn =
    warnAt === null || warnAt <= now
      ? null
      : setTimeout(() => {
          inBackground(`permission timeout: task ${request.task_id}`, async () => refreshBlocked(request.task_id))
        }, warnAt - now).unref()
  timers.set(request.id, { deny, warn })
}

/** Arms each request a call or a kept leftover waits on when raised or retimed; else disarms. */
export function watchPermissionTimeouts(): void {
  onAnyTaskEvent((_taskId, event) => {
    if (event.type !== 'permission') {
      return
    }
    if (event.request.state === 'pending' && (waitsFor(event.request.id) || isLateRequest(event.request.id))) {
      arm(event.request)
    } else {
      disarm(event.request.id)
    }
  })
}

/** Arms every pending request from its stored deadline at startup; overdue ones end at once. */
export async function resumePermissionTimeouts(): Promise<void> {
  for (const request of await permissionRequests.allPending()) {
    arm(request)
  }
}

export const permissionTimeout = async (): Promise<PermissionTimeoutSettings> => timeoutSettings.get()

/**
 * Sets the timeout, which only the user does. Pending requests take the new time counted from
 * when each was raised, so one already older than it is denied at once.
 */
export async function setPermissionTimeout(input: PermissionTimeoutInput): Promise<PermissionTimeoutSettings> {
  refuseAgent('change the permission request timeout')
  const before = await timeoutSettings.get()
  if (before.request_timeout_minutes === input.request_timeout_minutes) {
    return before
  }
  const after = await timeoutSettings.set(input.request_timeout_minutes)
  await audit.record({
    actor: 'user',
    kind: 'system.permission_timeout_changed',
    subject_type: 'system',
    summary:
      `Set the permission request timeout to ${timeoutLabel(after.request_timeout_minutes)}, ` +
      `was ${timeoutLabel(before.request_timeout_minutes)}`,
    detail: { from: before.request_timeout_minutes, to: after.request_timeout_minutes },
  })
  for (const request of await permissionRequests.allPending()) {
    const retimed = await permissionRequests.retime(
      request.id,
      timeoutAt(request.created_at, after.request_timeout_minutes),
    )
    if (retimed !== undefined) {
      await announce(retimed)
    }
  }
  return after
}

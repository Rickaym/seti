import { randomUUID } from 'node:crypto'
import {
  describeChange,
  hostEntry,
  urlAllowed,
  type AnswerChangeInput,
  type ChangeRequest,
  type FileChangeRequest,
  type RequestedChange,
  type Task,
} from '@seti/shared'
import { effectiveAccess, setTaskAccess } from './agent-access.js'
import { refuseArchived } from './archive-guard.js'
import { audit } from './audit.js'
import { sandboxed } from './aws-access.js'
import { inBackground } from './background.js'
import { closeRequest } from './change-request-notes.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { hasKey, placeKeyRequest } from './key-requests.js'
import { allowForEveryAgent } from './sandbox-policy.js'
import { allowedFor, changeRequests, taskHosts } from './store/change-requests.js'
import { refreshBlocked } from './task-blocked.js'

/** How long a request waits for the user before it expires. */
export const REQUEST_TTL_MS = 24 * 60 * 60_000
/** Requests one agent may have waiting at once, and may make in an hour. */
export const PENDING_MAX = 5
const HOURLY_MAX = 10
const HOUR_MS = 60 * 60_000
const EXPIRY_SWEEP_MS = 60_000

/** What filing a request came to: a new request, the same one still waiting, or nothing to ask. */
export type Filed = { outcome: 'filed' | 'waiting'; request: ChangeRequest } | { outcome: 'already'; text: string }

const SANDBOX_ONLY = 'You run unsandboxed, so the network allowlist and API key placeholders do not apply to you.'

async function mcpItem(task: Task, server: string) {
  const items = (await effectiveAccess(task)).items.filter((item) => item.kind === 'mcp')
  const item = items.find((entry) => entry.id === server || entry.name === server)
  if (item === undefined) {
    const names = items.map((entry) => entry.name).join(', ')
    throw new HttpError(404, `No MCP server is named ${server}; Seti has ${names === '' ? 'none' : names}.`)
  }
  return item
}

/** Why the agent need not ask, or null when the change is new to it; refuses what cannot apply. */
async function alreadyHas(task: Task, change: RequestedChange): Promise<string | null> {
  if (change.kind !== 'mcp_server' && !(await sandboxed(task))) {
    throw new HttpError(409, SANDBOX_ONLY)
  }
  switch (change.kind) {
    case 'allow_host': {
      const entries = await allowedFor(task.id)
      const exact = entries.includes(hostEntry(change)) || entries.includes(change.host)
      const covered = !change.host.startsWith('*.') && urlAllowed(`https://${hostEntry(change)}/`, entries)
      return exact || covered ? `You can already reach ${hostEntry(change)}.` : null
    }
    case 'api_key':
      return (await hasKey(task, change)) ? `Your credential already has ${change.env}.` : null
    case 'mcp_server':
      return (await mcpItem(task, change.server)).enabled ? `You already have the MCP server ${change.server}.` : null
  }
}

async function checkRate(task: Task): Promise<void> {
  if ((await changeRequests.pending(task.id)).length >= PENDING_MAX) {
    throw new HttpError(429, `At most ${String(PENDING_MAX)} of your requests can wait at once; wait for answers.`)
  }
  const since = new Date(Date.now() - HOUR_MS).toISOString()
  if ((await changeRequests.countSince(task.id, since)) >= HOURLY_MAX) {
    throw new HttpError(429, `At most ${String(HOURLY_MAX)} requests an hour; ask the user in chat instead.`)
  }
}

/** Files the agent's request for the user to allow or deny, once per pending change. */
export async function fileChangeRequest(task: Task, input: FileChangeRequest): Promise<Filed> {
  refuseArchived(task)
  const already = await alreadyHas(task, input.change)
  if (already !== null) {
    return { outcome: 'already', text: already }
  }
  const waiting = await changeRequests.pendingSame(task.id, input.change)
  if (waiting !== undefined) {
    return { outcome: 'waiting', request: waiting }
  }
  await checkRate(task)
  const request = await changeRequests.open({
    id: randomUUID(),
    task_id: task.id,
    change: input.change,
    reason: input.reason,
    profile_id: task.profile_id,
    expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
  })
  if (request === undefined) {
    throw new HttpError(409, 'The same request is already waiting for the user.')
  }
  await audit.record({
    actor: 'user',
    kind: 'task.change_requested',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Task "${task.title}" asked for ${describeChange(request.change)}`,
    detail: {
      title: task.title,
      request_id: request.id,
      kind: request.change.kind,
      change: describeChange(request.change),
      reason: request.reason,
    },
  })
  await refreshBlocked(task.id)
  return { outcome: 'filed', request }
}

/** The agent's requests that wait for the user, oldest first. */
export const pendingChanges = async (taskId: string) => changeRequests.pending(taskId)

async function apply(task: Task, request: ChangeRequest, answer: Extract<AnswerChangeInput, { decision: 'allow' }>) {
  const { change } = request
  switch (change.kind) {
    case 'allow_host':
      if (answer.scope === 'all') {
        await allowForEveryAgent(hostEntry(change))
      } else {
        await allowTaskHost(task, hostEntry(change))
      }
      return
    case 'mcp_server':
      await setTaskAccess(task, { kind: 'mcp', id: (await mcpItem(task, change.server)).id, enabled: true })
      return
    case 'api_key':
      await placeKeyRequest(task, change, answer.value)
      return
  }
}

/** The key the user pasted on Allow, which only a connection request takes. */
function pastedKey(request: ChangeRequest, answer: AnswerChangeInput): string | undefined {
  const value = answer.decision === 'allow' ? answer.value : undefined
  if (value !== undefined && request.change.kind !== 'api_key') {
    throw new HttpError(400, 'Only a connection request takes a key')
  }
  return value
}

/** The user's answer to a request; only the user answers, never the EA or an agent. */
export async function answerChangeRequest(task: Task, id: string, answer: AnswerChangeInput): Promise<ChangeRequest> {
  refuseAgent('answer change requests')
  const request = await changeRequests.get(id)
  if (request?.task_id !== task.id) {
    throw new HttpError(404, 'No change request with that id for this agent')
  }
  if (request.state !== 'pending' || Date.parse(request.expires_at) <= Date.now()) {
    throw new HttpError(409, 'This request was already answered or expired')
  }
  const value = pastedKey(request, answer)
  if (answer.decision === 'allow') {
    await apply(task, request, { decision: 'allow', scope: answer.scope ?? 'agent', value })
  }
  const scope = request.change.kind === 'allow_host' && answer.decision === 'allow' ? (answer.scope ?? 'agent') : null
  const settled = await changeRequests.settle(id, answer.decision === 'allow' ? 'allowed' : 'denied', scope)
  if (settled === undefined) {
    throw new HttpError(409, 'This request was already answered or expired')
  }
  await closeRequest(settled, answer.decision === 'allow' ? 'allowed' : 'denied', value !== undefined)
  return settled
}

/** Adds an allowlist entry for one agent alone; its proxy lets it through from the next request. */
async function allowTaskHost(task: Task, entry: string): Promise<void> {
  refuseAgent("change an agent's network allowlist")
  if (await taskHosts.add(task.id, entry)) {
    await audit.record({
      actor: 'user',
      kind: 'task.host_allowed',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Let task "${task.title}" reach ${entry}`,
      detail: { title: task.title, entry },
    })
  }
}

/** Takes an entry off one agent's own allowlist. */
export async function removeTaskHost(task: Task, entry: string): Promise<string[]> {
  refuseAgent("change an agent's network allowlist")
  if (!(await taskHosts.remove(task.id, entry))) {
    throw new HttpError(404, `${task.title} has no host ${entry} of its own`)
  }
  await audit.record({
    actor: 'user',
    kind: 'task.host_removed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Stopped task "${task.title}" reaching ${entry}`,
    detail: { title: task.title, entry },
  })
  return taskHosts.list(task.id)
}

/** Expires every request that waited past its time, telling each agent. */
export async function expireChangeRequests(): Promise<void> {
  for (const request of await changeRequests.expireDue(new Date().toISOString())) {
    await closeRequest(request, 'expired')
  }
}

/** Expires unanswered requests once a minute, after they waited a day. */
export function startRequestExpiry(): void {
  setInterval(() => {
    inBackground('change requests', expireChangeRequests)
  }, EXPIRY_SWEEP_MS).unref()
}

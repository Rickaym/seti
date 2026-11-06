import { describeChange, hostEntry, type ChangeRequest, type SetiInput } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { deliverInputs } from './inputs.js'
import { refreshBlocked } from './task-blocked.js'

type Outcome = SetiInput['kind']

/** What the agent learns of a pasted key: that it is in place, never the key or its length. */
const keyText = (env: string, keySet: boolean) =>
  `From your next turn your session has $${env}, holding a placeholder that Seti's proxy swaps for the ` +
  `key on its hosts${keySet ? '' : ' once the user pastes it'}. You never see the value; never print or ask for it.`

function allowedText(request: ChangeRequest, keySet: boolean): { title: string; body: string } {
  const { change } = request
  switch (change.kind) {
    case 'allow_host': {
      const who = request.scope === 'all' ? 'every sandboxed agent' : 'you'
      return {
        title: `The user allowed ${who} to reach ${hostEntry(change)}`,
        body: 'The proxy lets the next request through; retry what failed.',
      }
    }
    case 'api_key':
      return {
        title: `The user added the connection ${change.env}${keySet ? ' with its key' : ''}`,
        body: keyText(change.env, keySet),
      }
    case 'mcp_server':
      return {
        title: `The user turned on the MCP server ${change.server} for you`,
        body: 'Its tools load when your session restarts at your next turn.',
      }
  }
}

function textOf(request: ChangeRequest, outcome: Outcome, keySet: boolean): { title: string; body: string } {
  const what = describeChange(request.change)
  switch (outcome) {
    case 'allowed':
      return allowedText(request, keySet)
    case 'denied':
      return {
        title: `The user denied your request for ${what}`,
        body: 'Do not ask for it again; find another way, or ask the user in chat why.',
      }
    case 'expired':
      return {
        title: `Your request for ${what} expired unanswered`,
        body: 'Ask again only if you still need it.',
      }
  }
}

const AUDIT_KINDS = {
  allowed: 'task.change_allowed',
  denied: 'task.change_denied',
  expired: 'task.change_expired',
} as const

/**
 * Records how a request ended, tells the agent as an update, and takes it off the agent's reason
 * line. An expiry is Seti's; an answer is the user's. keySet means the user pasted the key on
 * Allow.
 */
export async function closeRequest(request: ChangeRequest, outcome: Outcome, keySet = false): Promise<void> {
  const task = await tasks.get(request.task_id)
  const title = task?.title ?? request.task_id
  const what = describeChange(request.change)
  const verbs = { allowed: 'Allowed', denied: 'Denied', expired: 'Expired' } as const
  await audit.record({
    actor: outcome === 'expired' ? 'system' : 'user',
    kind: AUDIT_KINDS[outcome],
    subject_type: 'task',
    subject_id: request.task_id,
    summary: `${verbs[outcome]} the request of task "${title}" for ${what}`,
    detail: {
      title,
      request_id: request.id,
      change: what,
      kind: request.change.kind,
      ...(request.scope === null ? {} : { scope: request.scope }),
    },
  })
  const text = textOf(request, outcome, keySet)
  const input: SetiInput = {
    source: 'seti',
    kind: outcome,
    request_id: request.id,
    subject: what,
    title: text.title,
    body: text.body,
    url: null,
  }
  await deliverInputs(request.task_id, [input])
  await refreshBlocked(request.task_id)
}

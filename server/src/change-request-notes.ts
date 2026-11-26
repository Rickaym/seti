import { describeChange, hostEntry, sharedToolCallName, type ChangeRequest, type SetiInput } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { deliverInputs, wakeTask } from './inputs.js'
import { mcpToolPrefix, probedTools } from './mcp-off-context.js'
import { auditTool } from './shared-tools.js'
import { refreshBlocked } from './task-blocked.js'

type Outcome = SetiInput['kind']

/** What the agent learns of a pasted key: that it is in place, never the key or its length. */
const keyText = (env: string, keySet: boolean) =>
  `From your next turn your session has $${env}, holding a placeholder that Seti's proxy swaps for the ` +
  `key on its hosts${keySet ? '' : ' once the user pastes it'}. You never see the value; never print or ask for it.`

const NAMED_TOOLS = 5

/** Where the agent finds the server's tools, since the turn that brings the note has them. */
function serverText(server: string): string {
  const tools = probedTools(server)
  const more = tools.length > NAMED_TOOLS ? ` and ${String(tools.length - NAMED_TOOLS)} more` : ''
  const named = tools.length === 0 ? '' : ` (${tools.slice(0, NAMED_TOOLS).join(', ')}${more})`
  return (
    `Your session restarted with it for this turn: its tools start with ${mcpToolPrefix(server)}${named}; ` +
    'carry on with what needed them. If none is there, background commands of yours still hold the old ' +
    'session or the server did not connect: say so, and do not search for another way.'
  )
}

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
      return { title: `The user turned on the MCP server ${change.server} for you`, body: serverText(change.server) }
    case 'command':
      return {
        title: `The user allowed ${change.line}`,
        body: `${change.description}. It applies from your next turn.`,
      }
    case 'shared_tool':
      return {
        title: `The user published your shared tool ${change.name}`,
        body:
          `Agents get it as the tool ${sharedToolCallName(change.name)} from their next turn, each only ` +
          'when its credential has the variables the tool needs.',
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

/** Records the answer; a tool's publishing records itself, and its denial goes by name and hash. */
async function auditOutcome(request: ChangeRequest, outcome: Outcome, title: string): Promise<void> {
  const what = describeChange(request.change)
  const verbs = { allowed: 'Allowed', denied: 'Denied', expired: 'Expired' } as const
  const summary = `${verbs[outcome]} the request of task "${title}" for ${what}`
  if (request.change.kind === 'shared_tool' && outcome !== 'expired') {
    if (outcome === 'denied') {
      const tool = { name: request.change.name, sha256: request.change.snapshot.sha256 }
      await auditTool({ kind: 'shared_tool.denied', tool, summary, taskId: request.task_id, requestId: request.id })
    }
    return
  }
  await audit.record({
    actor: outcome === 'expired' ? 'system' : 'user',
    kind: AUDIT_KINDS[outcome],
    subject_type: 'task',
    subject_id: request.task_id,
    summary,
    detail: {
      title,
      request_id: request.id,
      change: what,
      kind: request.change.kind,
      ...(request.change.kind === 'command' ? { command: request.change.line } : {}),
      ...(request.scope === null ? {} : { scope: request.scope }),
    },
  })
}

/**
 * Records how a request ended, tells the agent as an update, and takes it off the agent's reason
 * line. An expiry is Seti's; an answer is the user's, so the agent gets it without the wait that
 * groups updates. keySet means the user pasted the key on Allow.
 */
export async function closeRequest(request: ChangeRequest, outcome: Outcome, keySet = false): Promise<void> {
  const task = await tasks.get(request.task_id)
  const title = task?.title ?? request.task_id
  const what = describeChange(request.change)
  await auditOutcome(request, outcome, title)
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
  if (outcome !== 'expired') {
    await wakeTask(request.task_id)
  }
}

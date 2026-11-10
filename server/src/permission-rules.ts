import type {
  AddPermissionRuleInput,
  AgentPermissions,
  AnswerPermissionInput,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
  Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { permissionModeOf } from './bypass-mode.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { projectSettingsRules, userSettingsRules } from './inherited-rules.js'
import { builtInRules, GUARDS } from './permission-policy.js'
import { allowed, denied, resolveRequest, waitingInput, waitsFor } from './permission-requests.js'
import { liveSessions } from './runner.js'
import { permissionSettings } from './session-options.js'
import { permissionRequests, permissionRules } from './store/permissions.js'

/** Hands every open session the permission rules its task has now, or only the one task's. */
async function refreshPermissions(taskId?: string): Promise<void> {
  for (const [id, session] of liveSessions()) {
    const task = taskId === undefined || id === taskId ? await tasks.get(id) : undefined
    if (task !== undefined) {
      await session.applyPermissions(await permissionSettings(task)).catch((e: unknown) => {
        process.stderr.write(`permissions: task ${id}: could not update its session: ${String(e)}\n`)
      })
    }
  }
}

/** How many of an agent's past requests its transcript shows. */
const RECENT_REQUESTS = 50

export async function permissionPolicy(): Promise<PermissionPolicy> {
  return {
    built_in: builtInRules(),
    inherited: userSettingsRules(),
    guards: GUARDS,
    rules: await permissionRules.list(null),
  }
}

/** The agent's rules, with what it loads from its project's Claude Code settings too. */
export async function agentPermissions(task: Task): Promise<AgentPermissions> {
  return {
    ...(await permissionPolicy()),
    own: await permissionRules.list(task.id),
    project: projectSettingsRules(task.cwd),
  }
}

async function auditRule(task: Task | null, rule: PermissionRule, change: 'added' | 'removed'): Promise<void> {
  const verb = change === 'added' ? 'Added' : 'Removed'
  const what = `${rule.behavior} rule ${rule.rule}`
  const detail = { behavior: rule.behavior, rule: rule.rule }
  await (task === null
    ? audit.record({
        actor: 'user',
        kind: `system.permission_rule_${change}`,
        subject_type: 'system',
        summary: `${verb} the ${what} for every agent`,
        detail,
      })
    : audit.record({
        actor: 'user',
        kind: `task.permission_rule_${change}`,
        subject_type: 'task',
        subject_id: task.id,
        summary: `${verb} the ${what} for task "${task.title}"`,
        detail: { ...detail, title: task.title },
      }))
}

const RULES_ARE_THE_USERS = 'change permission rules'

/** Adds a rule for every agent with `task` null, else for that agent; open sessions take it now. */
export async function addPermissionRule(task: Task | null, input: AddPermissionRuleInput): Promise<PermissionRule> {
  refuseAgent(RULES_ARE_THE_USERS)
  const { rule, added } = await permissionRules.add(task?.id ?? null, input.behavior, input.rule)
  if (added) {
    await auditRule(task, rule, 'added')
    await refreshPermissions(task?.id)
  }
  return rule
}

export async function removePermissionRule(task: Task | null, ruleId: number): Promise<void> {
  refuseAgent(RULES_ARE_THE_USERS)
  const rule = await permissionRules.remove(task?.id ?? null, ruleId)
  if (rule === undefined) {
    throw new HttpError(404, 'No such rule')
  }
  await auditRule(task, rule, 'removed')
  await refreshPermissions(task?.id)
}

export const pendingRequests = async (): Promise<PermissionRequest[]> => permissionRequests.allPending()

export const taskRequests = async (taskId: string): Promise<PermissionRequest[]> =>
  (await permissionRequests.recent(taskId, RECENT_REQUESTS)).toReversed()

/** Keeps the rules Always allow offered for the request, for the agent or for every agent. */
async function keepRules(task: Task, request: PermissionRequest, scope: PermissionScope): Promise<void> {
  for (const rule of request.suggestions) {
    await addPermissionRule(scope === 'global' ? null : task, { behavior: 'allow', rule })
  }
}

async function auditAnswer(task: Task, request: PermissionRequest, input: AnswerPermissionInput): Promise<void> {
  const allow = input.decision !== 'deny'
  const kept =
    request.kind === 'repeat'
      ? ' and stopped asking about this repeat'
      : ` and always allowed ${request.suggestions.join(', ')}`
  const always = input.decision === 'always' ? kept : ''
  await audit.record({
    actor: 'user',
    kind: allow ? 'task.permission_allowed' : 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${allow ? 'Allowed' : 'Denied'} ${request.tool_name} for task "${task.title}"${always}`,
    detail: {
      title: task.title,
      tool: request.tool_name,
      call: request.summary,
      decision: input.decision,
      ...(request.kind === 'repeat' ? { repeat: true } : {}),
      ...(input.decision === 'always' ? { scope: input.scope ?? 'agent', rules: request.suggestions } : {}),
      ...(input.message === undefined || input.message === '' ? {} : { message: input.message }),
    },
  })
}

/** The user's answer to a request the agent waits on; Always allow also keeps its rules, if any. */
export async function answerPermission(
  task: Task,
  requestId: string,
  input: AnswerPermissionInput,
): Promise<PermissionRequest> {
  refuseAgent('answer permission requests')
  const request = await permissionRequests.get(requestId)
  if (request?.task_id !== task.id) {
    throw new HttpError(404, 'No such permission request')
  }
  if (request.state !== 'pending' || !waitsFor(request.id)) {
    throw new HttpError(409, 'The agent no longer waits on this request')
  }
  if (input.decision === 'always' && request.suggestions.length === 0 && request.kind !== 'repeat') {
    throw new HttpError(409, 'This call has no rule to always allow; allow it once instead')
  }
  const message = input.decision === 'deny' ? (input.message ?? null) : null
  const settled = await permissionRequests.settle(request.id, input.decision === 'deny' ? 'denied' : 'allowed', message)
  if (settled === undefined) {
    throw new HttpError(409, 'The agent no longer waits on this request')
  }
  if (input.decision === 'always') {
    await keepRules(task, settled, input.scope ?? 'agent')
  }
  await auditAnswer(task, settled, input)
  const always = input.decision === 'always'
  const result =
    input.decision === 'deny'
      ? denied(message)
      : allowed(settled, waitingInput(settled.id), permissionModeOf(task), always)
  await resolveRequest(settled, result)
  return settled
}

/** The task the route names, for answers and rules of that agent. */
export async function taskFor(taskId: string): Promise<Task> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    throw new HttpError(404, 'Task not found')
  }
  return task
}

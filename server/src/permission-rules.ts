import type {
  AddPermissionRuleInput,
  AddPermissionRulesInput,
  AgentPermissions,
  AnswerPermissionInput,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
  ReviewCoverage,
  Task,
} from '@seti/shared'
import { claudeRules } from './approval-ceiling.js'
import { audit } from './audit.js'
import { permissionModeOf } from './bypass-mode.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { noteEdit } from './edit-marks.js'
import { editedRunNote, type EditedValues } from './edit-notes.js'
import { heldFolderSettings } from './folder-settings-trust.js'
import { HttpError } from './http.js'
import { projectSettingsRules, userSettingsRules } from './inherited-rules.js'
import { controlLink } from './node-link.js'
import { changedFields, withFields } from './permission-edits.js'
import { builtInRules, GUARDS } from './permission-policy.js'
import { allowed, denied, inputText, resolveRequest, waitingInput, waitsFor } from './permission-requests.js'
import { deliverLateDecision, isLateRequest } from './restart-waits.js'
import { reviewCoverage, reviewGaps } from './review-coverage.js'
import { permissionRequests, permissionRules } from './store/permissions.js'

/** Hands every open session the permission rules its task has now, or only the one task's. */
async function refreshPermissions(taskId?: string): Promise<void> {
  const { sessions } = await controlLink.command('sessions.view', {})
  for (const { agent: id } of sessions) {
    const task = taskId === undefined || id === taskId ? await tasks.get(id) : undefined
    if (task !== undefined) {
      const policy = await claudeRules(task)
      await controlLink.command('policy.set', { agent: id, policy }).catch((e: unknown) => {
        process.stderr.write(`permissions: task ${id}: could not update its session: ${String(e)}\n`)
      })
    }
  }
}

/** How many of an agent's past requests its transcript shows. */
const RECENT_REQUESTS = 50

const reviewRules = (rules: readonly PermissionRule[]) =>
  rules.filter((rule) => rule.behavior === 'review').map((rule) => rule.rule)

export async function permissionPolicy(): Promise<PermissionPolicy> {
  const rules = await permissionRules.list(null)
  const review = reviewRules(rules)
  return {
    built_in: builtInRules(),
    inherited: userSettingsRules(),
    guards: GUARDS,
    rules,
    review_gaps: reviewGaps(review, review),
  }
}

/** The agent's rules, with what it loads from its project's Claude Code settings too. */
export async function agentPermissions(task: Task): Promise<AgentPermissions> {
  const policy = await permissionPolicy()
  const own = await permissionRules.list(task.id)
  const review = reviewRules(own)
  return {
    ...policy,
    own,
    project: projectSettingsRules(task.cwd, await heldFolderSettings(task.cwd)),
    review_gaps: reviewGaps(review, [...reviewRules(policy.rules), ...review]),
  }
}

/** The writing tools of a rule's server; `task` null counts only the review rules for every agent. */
export async function ruleCoverage(task: Task | null, rule: string): Promise<ReviewCoverage> {
  const own = task === null ? [] : await permissionRules.list(task.id)
  return reviewCoverage(rule, reviewRules([...(await permissionRules.list(null)), ...own]))
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

/** Adds rules for every agent with `task` null, else for that agent; open sessions take them now. */
export async function addPermissionRules(task: Task | null, input: AddPermissionRulesInput): Promise<PermissionRule[]> {
  refuseAgent(RULES_ARE_THE_USERS)
  const rules: PermissionRule[] = []
  let changed = false
  try {
    for (const text of new Set(input.rules)) {
      const { rule, added } = await permissionRules.add(task?.id ?? null, input.behavior, text)
      rules.push(rule)
      if (added) {
        changed = true
        await auditRule(task, rule, 'added')
      }
    }
  } finally {
    if (changed) {
      await refreshPermissions(task?.id)
    }
  }
  return rules
}

/** Adds one rule, as addPermissionRules does. */
export async function addPermissionRule(task: Task | null, input: AddPermissionRuleInput): Promise<PermissionRule> {
  const [rule] = await addPermissionRules(task, { behavior: input.behavior, rules: [input.rule] })
  if (rule === undefined) {
    throw new HttpError(500, 'The rule was not added')
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

async function auditAnswer(
  task: Task,
  request: PermissionRequest,
  input: AnswerPermissionInput,
  edited: readonly string[],
): Promise<void> {
  const allow = input.decision !== 'deny'
  const kept =
    request.kind === 'repeat'
      ? ' and stopped asking about this repeat'
      : ` and always allowed ${request.suggestions.join(', ')}`
  const always = input.decision === 'always' ? kept : ''
  const changed = edited.length > 0 ? ` with ${edited.join(', ')} edited` : ''
  await audit.record({
    actor: 'user',
    kind: allow ? 'task.permission_allowed' : 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${allow ? 'Allowed' : 'Denied'} ${request.tool_name} for task "${task.title}"${changed}${always}`,
    detail: {
      title: task.title,
      tool: request.tool_name,
      call: request.summary,
      decision: input.decision,
      ...(request.kind === 'repeat' ? { repeat: true } : {}),
      ...(request.kind === 'review' ? { review: true } : {}),
      ...(edited.length > 0 ? { edited: [...edited] } : {}),
      ...(input.decision === 'always' ? { scope: input.scope ?? 'agent', rules: request.suggestions } : {}),
      ...(input.message === undefined || input.message === '' ? {} : { message: input.message }),
    },
  })
}

/**
 * The input an allowed call runs with, the fields the user's edits change with their new values,
 * and the input the request keeps when an allowed call runs changed.
 */
function callOf(request: PermissionRequest, input: AnswerPermissionInput) {
  const original = waitingInput(request.id)
  const fields = input.fields ?? {}
  if (isLateRequest(request.id)) {
    if (Object.keys(fields).length > 0) {
      throw new HttpError(409, 'A restart ended this call, so it cannot be edited; allow or deny it as it is')
    }
    return { call: original, edited: {}, shown: undefined }
  }
  const changed = changedFields(original, fields)
  if (changed.length === 0) {
    return { call: original, edited: {}, shown: undefined }
  }
  if (!request.editable) {
    throw new HttpError(409, 'This call cannot be edited; allow or deny it as it is')
  }
  const call = withFields(original, fields)
  const edited: EditedValues = Object.fromEntries(changed.map((key) => [key, fields[key] ?? '']))
  return { call, edited, shown: input.decision === 'deny' ? undefined : inputText(call) }
}

/** The task's request the answer is for; refused unless a call or a restart's leftover waits. */
async function answerable(task: Task, requestId: string, input: AnswerPermissionInput): Promise<PermissionRequest> {
  const request = await permissionRequests.get(requestId)
  if (request?.task_id !== task.id) {
    throw new HttpError(404, 'No such permission request')
  }
  if (request.state !== 'pending' || !(waitsFor(request.id) || isLateRequest(request.id))) {
    throw new HttpError(409, 'The agent no longer waits on this request')
  }
  if (input.decision === 'always' && request.suggestions.length === 0 && request.kind !== 'repeat') {
    throw new HttpError(409, 'This call has no rule to always allow; allow it once instead')
  }
  return request
}

/** Refuses what a Codex agent cannot take: Always, whose rule would not answer for it, or a note. */
function refuseOnCodex(task: Task, input: AnswerPermissionInput): void {
  if (task.runtime !== 'codex') {
    return
  }
  if (input.decision === 'always') {
    throw new HttpError(400, "A Codex agent's request takes Allow or Deny; a rule would not answer for it")
  }
  if (input.decision === 'deny' && (input.message ?? '') !== '') {
    throw new HttpError(400, 'Codex tells its agent only that you refused; it cannot pass on a note')
  }
}

/**
 * The user's answer to a request the agent waits on; Always allow also keeps its rules, if any.
 * The answer to a request a restart cut off resumes the agent with it instead.
 */
export async function answerPermission(
  task: Task,
  requestId: string,
  input: AnswerPermissionInput,
): Promise<PermissionRequest> {
  refuseAgent('answer permission requests')
  refuseOnCodex(task, input)
  const request = await answerable(task, requestId, input)
  const late = isLateRequest(request.id)
  const deny = input.decision === 'deny'
  const message = deny ? (input.message ?? null) : null
  const { call, edited, shown } = callOf(request, input)
  const names = Object.keys(edited)
  const settled = await permissionRequests.settle(request.id, deny ? 'denied' : 'allowed', message, {
    input: shown,
    edited: names,
  })
  if (settled === undefined) {
    throw new HttpError(409, 'The agent no longer waits on this request')
  }
  if (input.decision === 'always') {
    await keepRules(task, settled, input.scope ?? 'agent')
  }
  await auditAnswer(task, settled, input, names)
  const result = deny
    ? denied(message, edited)
    : allowed(settled, call, await permissionModeOf(task), input.decision === 'always')
  await noteEdit(task, settled)
  await resolveRequest(settled, result, deny || names.length === 0 ? undefined : editedRunNote(edited))
  if (late) {
    await deliverLateDecision(settled)
  }
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

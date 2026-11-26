import { RUNTIME_NAMES, type NodeAnswer, type PolicyShadowCount, type Task, type ToolCall } from '@seti/shared'
import { reasonForRef } from './ask-rule-held.js'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { heldFolderSettings } from './folder-settings-trust.js'
import { outsidePushes } from './outward-push.js'
import { guardCommand } from './permission-guard.js'
import { answerByRules, askCodexUser, type UserAnswer } from './permission-requests.js'
import { compareOutcomes } from './policy/compare.js'
import { decide } from './policy/evaluate.js'
import { namedPaths } from './policy/named-paths.js'
import { sourcedRules } from './policy/sources.js'
import { policyCall } from './policy/tool-call.js'
import type { Decision, PolicyCall, PolicyContext } from './policy/types.js'
import { pushReason } from './push-asks.js'
import { askQuestions } from './questions.js'
import { resolvePaths } from './resolve-paths.js'
import { rulesDecide } from './rules-decide.js'
import { redactSecrets } from './scrub.js'
import { guardScope, ruleSources, workingDirs } from './session-options.js'
import { countShadow } from './shadow-counts.js'

type Verdict = NodeAnswer<'call.decide'>

/** The context Seti's evaluator reads a Codex agent's call in; Codex runs only sandboxed. */
async function contextOf(task: Task): Promise<PolicyContext> {
  const scope = guardScope(task, true)
  return {
    mode: 'ask',
    rules: sourcedRules(await ruleSources(task, await heldFolderSettings(task.cwd))),
    cwd: task.cwd,
    dirs: [task.cwd, ...workingDirs(task)],
    home: scope.home,
    classifier: false,
    guard: (call) => (call.command === undefined ? null : guardCommand(call.command, scope)),
  }
}

/** The call as the evaluator reads it, with where the paths it names lead. */
async function readCall(call: ToolCall, ctx: PolicyContext): Promise<PolicyCall> {
  const given = policyCall(call)
  const resolved = await resolvePaths(namedPaths(given, ctx), [ctx.cwd, ...ctx.dirs, ctx.home])
  return resolved.size === 0 ? given : { ...given, resolved }
}

/** A call's input as a permission request shows it: the command, the files and diff, or the input. */
function shownInput(call: ToolCall): Record<string, unknown> {
  if (call.shell?.command !== undefined) {
    return { command: call.shell.command }
  }
  const changes = call.edit?.changes ?? []
  if (changes.length > 0) {
    return { file_path: changes.map((change) => change.path).join(', '), diff: changes[0]?.diff ?? '' }
  }
  return typeof call.input === 'object' && call.input !== null ? { ...call.input } : {}
}

/** The folder Codex runs a command in, which it names with each call. */
const cwdOf = (call: ToolCall): string | null => {
  const input = call.input as { cwd?: unknown } | null
  return typeof input?.cwd === 'string' ? input.cwd : null
}

/** The command whose PRs the request shows, run in the folder Codex names, and why Codex runs it. */
const shellOf = (read: PolicyCall, call: ToolCall, task: Task) => ({
  ...(read.command === undefined ? {} : { shell: { command: read.command, cwd: cwdOf(call) ?? task.cwd } }),
  ...(call.shell?.description === undefined ? {} : { description: call.shell.description }),
})

/** Seti's reason line naming the ask rule that holds the call, or null for any other decision. */
const ruleReason = (decision: Decision, ctx: PolicyContext) =>
  decision.step === 'ask-rule' ? (reasonForRef(ctx.rules, decision.rule) ?? decision.reason) : null

/** The reason line of a call that goes to the user because nothing else answers it. */
const userAnswers = (task: Task) => `${RUNTIME_NAMES[task.runtime]} agents ask before every command, edit and tool call`

/** A Codex call waiting for the user, by request id, which the rules decide once turned on. */
interface WaitingCall {
  taskId: string
  call: ToolCall
}

const waitingCalls = new Map<string, WaitingCall>()

/** Waiting calls the rules answered, which are not counted as the user's answers. */
const answeredByRules = new WeakSet<WaitingCall>()

/** Records what Seti's evaluator would have said beside the user's answer: counts and refs only. */
function recordBeside(call: PolicyCall, decision: Decision, result: UserAnswer, slow: boolean): void {
  if (!result.allow && result.dropped) {
    return
  }
  const answer = result.allow ? 'allow' : 'deny'
  const count: PolicyShadowCount = {
    kind: call.kind,
    tool: call.mcp === undefined ? call.name : 'mcp',
    mode: 'codex',
    sandboxed: true,
    slow,
    verdict: decision.verdict,
    step: decision.step,
    rule: decision.rule ?? '',
    runtime: `user-${answer}`,
    result: compareOutcomes(decision, answer),
  }
  countShadow(count)
}

/** Records a call Seti refused at once by a guard or a deny rule, without its input. */
async function auditRefused(task: Task, call: PolicyCall, decision: Decision): Promise<void> {
  await audit.record({
    actor: 'system',
    kind: 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Refused a call of task "${task.title}": ${redactSecrets(decision.reason)}`,
    detail: { title: task.title, tool: call.name, guard: decision.step === 'guard', rule: decision.rule },
  })
}

/** The user's answers to a Codex agent's questions, by question text, as Codex is answered. */
async function askedUser(task: Task, call: ToolCall, signal: AbortSignal): Promise<Verdict> {
  const questions = (call.question?.questions ?? []).map((one) => ({
    question: one.text,
    header: one.header ?? one.text,
    options: one.options.map((label) => ({ label })),
    multiSelect: one.multiple === true,
  }))
  const options = { signal, toolUseID: call.callId, requestId: call.callId, suggestions: [] }
  const result = await askQuestions(task.id, { questions }, options, signal)
  if (result.behavior !== 'allow') {
    return { allow: false, message: result.message }
  }
  const given = result.updatedInput?.answers
  const entries = typeof given === 'object' && given !== null ? Object.entries(given) : []
  const answers = entries.map(([text, answer]) => [text, Array.isArray(answer) ? answer.join(', ') : String(answer)])
  return { allow: true, input: { answers: Object.fromEntries(answers) } }
}

/**
 * Seti's answer to a Codex agent's call. Seti's guards and the user's deny rules refuse it at
 * once; a review or ask rule asks as it does for any agent; an allow runs the call while Seti's
 * rules decide for Codex agents (the default); any other call goes to the user, with Allow and
 * Deny only. Beside each answer the user gives, the evaluator's own verdict is counted.
 */
export async function decideCodexCall(taskId: string, call: ToolCall, signal: AbortSignal): Promise<Verdict> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return { allow: false, message: 'This agent was deleted.' }
  }
  if (call.kind === 'question') {
    return askedUser(task, call, signal)
  }
  const ctx = await contextOf(task)
  const read = await readCall(call, ctx)
  const started = performance.now()
  const decision = decide(read, ctx)
  const slow = performance.now() - started > 50
  if (decision.verdict === 'deny') {
    await auditRefused(task, read, decision)
    return { allow: false, message: decision.reason }
  }
  const pushes = read.command === undefined ? [] : await outsidePushes(task, read.command, cwdOf(call) ?? task.cwd)
  if (pushes.length === 0 && decision.verdict === 'allow' && (await rulesDecide(task.runtime))) {
    return { allow: true }
  }
  const review = decision.verdict === 'review'
  const ruled = ruleReason(decision, ctx) ?? (review ? decision.reason : userAnswers(task))
  const reason = pushes.length > 0 ? pushReason(pushes) : ruled
  const waits: WaitingCall = { taskId: task.id, call }
  const ids: string[] = []
  const opened = (id: string) => {
    ids.push(id)
    waitingCalls.set(id, waits)
  }
  const ask = { tool: read.name, input: shownInput(call), review, reason, opened, ...shellOf(read, call, task) }
  try {
    const result = await askCodexUser(task.id, ask, [signal])
    if (!answeredByRules.has(waits)) {
      recordBeside(read, decision, result, slow)
    }
    return result.allow ? { allow: true } : { allow: false, message: result.message }
  } finally {
    for (const id of ids) {
      waitingCalls.delete(id)
    }
  }
}

/** Records a waiting call the rules answered, without its input. */
async function auditByRules(task: Task, call: PolicyCall, decision: Decision): Promise<void> {
  const allow = decision.verdict === 'allow'
  await audit.record({
    actor: 'system',
    kind: allow ? 'task.permission_allowed' : 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${allow ? 'Allowed' : 'Refused'} a waiting call of task "${task.title}" by the rules: ${redactSecrets(decision.reason)}`,
    detail: { title: task.title, tool: call.name, by: 'rules', step: decision.step, rule: decision.rule },
  })
}

/** Decides one waiting call by the rules: an allow or a deny answers it, anything else waits on. */
async function redecide(id: string, waits: WaitingCall): Promise<void> {
  const task = await tasks.get(waits.taskId)
  if (task === undefined) {
    return
  }
  const ctx = await contextOf(task)
  const read = await readCall(waits.call, ctx)
  const decision = decide(read, ctx)
  if (decision.verdict !== 'allow' && decision.verdict !== 'deny') {
    return
  }
  if (decision.verdict === 'allow' && read.command !== undefined) {
    const pushes = await outsidePushes(task, read.command, cwdOf(waits.call) ?? task.cwd)
    if (pushes.length > 0) {
      return
    }
  }
  const answer: UserAnswer =
    decision.verdict === 'allow' ? { allow: true } : { allow: false, message: decision.reason, dropped: false }
  const won = () => {
    answeredByRules.add(waits)
  }
  if ((await answerByRules(id, answer, won)) === undefined) {
    return
  }
  await auditByRules(task, read, decision)
}

/**
 * Once the user lets the rules decide for Codex agents, decides every Codex call still waiting
 * for them as a new call would be: allowed or refused by the rules, else it waits on.
 */
export async function redecideWaitingCodexCalls(runtime: Task['runtime'] = 'codex'): Promise<void> {
  for (const [id, waits] of [...waitingCalls]) {
    if ((await tasks.get(waits.taskId))?.runtime === runtime) {
      await redecide(id, waits)
    }
  }
}

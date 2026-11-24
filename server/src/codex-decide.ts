import type { NodeAnswer, PolicyShadowCount, Task, ToolCall } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { guardCommand } from './permission-guard.js'
import { askCodexUser, type UserAnswer } from './permission-requests.js'
import { compareOutcomes } from './policy/compare.js'
import { decide } from './policy/evaluate.js'
import { namedPaths } from './policy/named-paths.js'
import { sourcedRules } from './policy/sources.js'
import { policyCall } from './policy/tool-call.js'
import type { Decision, PolicyCall, PolicyContext } from './policy/types.js'
import { askQuestions } from './questions.js'
import { resolvePaths } from './resolve-paths.js'
import { redactSecrets } from './scrub.js'
import { guardScope, ruleSources, workingDirs } from './session-options.js'
import { countShadow } from './shadow-counts.js'
import { codexSettings } from './store/codex-settings.js'

type Verdict = NodeAnswer<'call.decide'>

/** The context Seti's evaluator reads a Codex agent's call in; Codex runs only sandboxed. */
async function contextOf(task: Task): Promise<PolicyContext> {
  const scope = guardScope(task, true)
  return {
    mode: 'ask',
    rules: sourcedRules(await ruleSources(task)),
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

const USER_ANSWERS = 'Codex agents ask before every command, edit and tool call'

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
  if (decision.verdict === 'allow' && (await codexSettings.get()).evaluator_decides) {
    return { allow: true }
  }
  const review = decision.verdict === 'review'
  const reason = review || decision.step === 'ask-rule' ? decision.reason : USER_ANSWERS
  const ask = { tool: read.name, input: shownInput(call), review, reason }
  const result = await askCodexUser(task.id, ask, [signal])
  recordBeside(read, decision, result, slow)
  return result.allow ? { allow: true } : { allow: false, message: result.message }
}

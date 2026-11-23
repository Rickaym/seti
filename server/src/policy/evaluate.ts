import { insideAny, resolvePath } from './paths.js'
import { readOnly } from './read-only.js'
import { matchesCall, prepare, type Prepared } from './rule-match.js'
import { droppedInAuto } from './rule-parse.js'
import { criticalRemoval, isProtected } from './safety.js'
import { commandShape } from './shell-forms.js'
import { shellAllow, shellMatch } from './shell-rules.js'
import { splitShell } from './shell-split.js'
import type { Decision, DecisionStep, PolicyCall, PolicyContext, PolicyMode, RuleBehavior, Verdict } from './types.js'

const decision = (verdict: Verdict, step: DecisionStep, reason: string, rule: Prepared | null = null): Decision => ({
  verdict,
  step,
  rule: rule?.rule.ref ?? null,
  reason,
})

const ofBehavior = (rules: readonly Prepared[], behavior: RuleBehavior) =>
  rules.filter((prepared) => prepared.rule.behavior === behavior)

/** The first deny or ask rule that matches the call, its command included. */
function firstMatch(rules: readonly Prepared[], call: PolicyCall, ctx: PolicyContext): Prepared | undefined {
  const direct = rules.find((prepared) => matchesCall(prepared, call, ctx))
  return direct ?? (call.command === undefined ? undefined : shellMatch(call.command, rules, ctx))
}

/** Seti's review rules name a tool-server tool or a whole server, bare or as `server__*`. */
const reviews = (text: string, tool: string) => {
  const server = text.endsWith('__*') ? text.slice(0, -3) : text
  return text === tool || tool.startsWith(`${server}__`)
}

/** Why no allow rule may approve the call, whatever it says, or null. */
function unsafe(call: PolicyCall, ctx: PolicyContext): 'critical' | 'protected' | null {
  if (call.command !== undefined) {
    const where = { cwd: ctx.cwd, home: ctx.home, dirs: ctx.dirs }
    const shapes = splitShell(call.command).all.map(commandShape)
    return shapes.some((shape) => criticalRemoval(shape.words, where)) ? 'critical' : null
  }
  const writes = call.writes.map((given) => resolvePath(given, ctx.cwd, ctx.home))
  return call.kind === 'edit' && writes.some(isProtected) ? 'protected' : null
}

/** Modes that hand undecided calls to the classifier, which drop the broad allow rules first. */
const classified = (mode: PolicyMode) => mode === 'auto' || mode === 'plan'

/** The sandbox's built-in `Bash` allow, kept in auto without a classifier for fully read lines. */
const sandboxShell = ({ rule, target }: Prepared) =>
  rule.ref.startsWith('builtin:') && target.type === 'tool' && target.name === 'Bash'

/** A shell call Seti reads in full that keeps no terminal open for later input. */
const fullyRead = (call: PolicyCall) =>
  call.command !== undefined && call.interactive !== true && splitShell(call.command).plain

/** The allow rules the mode keeps: a mode with a classifier behind it drops the broad ones. */
function usableAllows(call: PolicyCall, rules: readonly Prepared[], ctx: PolicyContext): readonly Prepared[] {
  if (!classified(ctx.mode)) {
    return rules
  }
  const read = ctx.mode === 'auto' && !ctx.classifier && fullyRead(call)
  return rules.filter((prepared) => !droppedInAuto(prepared.target) || (read && sandboxShell(prepared)))
}

function allowRule(call: PolicyCall, rules: readonly Prepared[], ctx: PolicyContext): Prepared | undefined {
  const usable = usableAllows(call, rules, ctx)
  if (call.command !== undefined) {
    return shellAllow(call.command, call.interactive === true, usable, ctx)
  }
  return usable.find((prepared) => matchesCall(prepared, call, ctx))
}

/** Tools that only track the agent's own work, which no mode asks about. */
const UNASKED = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'BashOutput',
  'EnterPlanMode',
])

/** What the mode does with a call no rule decided. */
function byMode(call: PolicyCall, ctx: PolicyContext): Decision {
  if (ctx.mode === 'bypass' || UNASKED.has(call.name)) {
    return decision('allow', 'mode', ctx.mode === 'bypass' ? 'Bypass allows it' : "It only tracks the agent's own work")
  }
  const inside = (paths: readonly string[]) =>
    paths.length > 0 && paths.every((given) => insideAny(resolvePath(given, ctx.cwd, ctx.home), ctx.dirs))
  const reads = call.kind === 'read' || call.kind === 'search'
  if (reads && (ctx.mode === 'auto' || inside(call.reads))) {
    return decision('allow', 'mode', 'It reads, inside the working directories or in auto mode')
  }
  if (ctx.mode === 'auto' && call.kind === 'edit' && inside(call.writes)) {
    return decision('allow', 'mode', 'Auto mode allows edits inside the working directories')
  }
  if (ctx.classifier && (ctx.mode === 'auto' || (ctx.mode === 'plan' && call.kind !== 'edit'))) {
    return decision('defer', 'mode', "No rule decides it, so the runtime's classifier does")
  }
  return decision('ask', 'mode', 'No rule allows it')
}

/** A protected write runs in bypass, goes to the classifier in auto, and asks otherwise. */
const PROTECTED: Record<PolicyMode, Verdict> = { bypass: 'allow', auto: 'defer', ask: 'ask', plan: 'ask' }

const protectedWrite = (ctx: PolicyContext): Verdict =>
  PROTECTED[ctx.mode] === 'defer' && !ctx.classifier ? 'ask' : PROTECTED[ctx.mode]

/** Without a classifier, Seti's own read-only list lets a line it fully reads run in every mode. */
const readsOnly = (call: PolicyCall, ctx: PolicyContext) =>
  !ctx.classifier &&
  ctx.mode !== 'bypass' &&
  call.command !== undefined &&
  call.interactive !== true &&
  readOnly(call.command, ctx)

function afterRules(call: PolicyCall, rules: readonly Prepared[], ctx: PolicyContext): Decision {
  const risk = unsafe(call, ctx)
  if (risk === 'critical') {
    return decision('ask', 'safety', 'It removes the root, home, a top-level or a working directory')
  }
  if (risk === 'protected') {
    return decision(protectedWrite(ctx), 'safety', 'It writes repository state or configuration that runs code')
  }
  if (ctx.mode === 'plan' && call.kind === 'edit') {
    return decision('ask', 'plan', 'Plan mode edits nothing until the user approves the plan')
  }
  const allow = allowRule(call, ofBehavior(rules, 'allow'), ctx)
  if (allow !== undefined) {
    return decision('allow', 'allow-rule', 'An allow rule matches', allow)
  }
  return readsOnly(call, ctx) ? decision('allow', 'read-only', "It only reads, by Seti's list") : byMode(call, ctx)
}

/**
 * Seti's decision on one tool call: guards, then deny, review and ask rules, then what no
 * rule may approve, then allow rules, then the mode. It never allows a call it cannot read.
 */
export function decide(call: PolicyCall, ctx: PolicyContext): Decision {
  const refused = ctx.guard?.(call) ?? null
  if (refused !== null) {
    return decision('deny', 'guard', refused)
  }
  const rules = prepare(ctx.rules)
  const deny = firstMatch(ofBehavior(rules, 'deny'), call, ctx)
  if (deny !== undefined) {
    return decision('deny', 'deny-rule', 'A deny rule matches', deny)
  }
  const review =
    call.mcp === undefined ? undefined : ofBehavior(rules, 'review').find((p) => reviews(p.rule.text, call.name))
  if (review !== undefined) {
    return decision('review', 'review-rule', 'A review rule holds it for the user', review)
  }
  const ask = firstMatch(ofBehavior(rules, 'ask'), call, ctx)
  if (ask !== undefined) {
    return decision('ask', 'ask-rule', 'An ask rule matches', ask)
  }
  if (call.kind === 'question') {
    return decision('ask', 'question', 'Only the user answers a question')
  }
  if (call.name === 'ExitPlanMode') {
    return decision('ask', 'plan', 'Only the user approves a plan')
  }
  return afterRules(call, rules, ctx)
}

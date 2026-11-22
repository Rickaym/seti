import { insideAny, resolvePath } from './paths.js'
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

function allowRule(call: PolicyCall, rules: readonly Prepared[], ctx: PolicyContext): Prepared | undefined {
  const usable = ctx.mode === 'auto' ? rules.filter((prepared) => !droppedInAuto(prepared.target)) : rules
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
  if (ctx.mode === 'auto' || (ctx.mode === 'plan' && call.kind !== 'edit')) {
    return decision('defer', 'mode', "No rule decides it, so the runtime's classifier does")
  }
  return decision('ask', 'mode', 'No rule allows it')
}

/** A protected write runs in bypass, goes to the classifier in auto, and asks otherwise. */
const PROTECTED: Record<PolicyMode, Verdict> = { bypass: 'allow', auto: 'defer', ask: 'ask', plan: 'ask' }

function afterRules(call: PolicyCall, rules: readonly Prepared[], ctx: PolicyContext): Decision {
  const risk = unsafe(call, ctx)
  if (risk === 'critical') {
    return decision('ask', 'safety', 'It removes the root, home, a top-level or a working directory')
  }
  if (risk === 'protected') {
    return decision(PROTECTED[ctx.mode], 'safety', 'It writes repository state or configuration that runs code')
  }
  const allow = allowRule(call, ofBehavior(rules, 'allow'), ctx)
  return allow === undefined ? byMode(call, ctx) : decision('allow', 'allow-rule', 'An allow rule matches', allow)
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

import { pathMatches, resolvePath, type PathScope } from './paths.js'
import { domainMatches, nameMatches, valueMatches } from './patterns.js'
import { parseRule, type RuleTarget } from './rule-parse.js'
import type { PolicyCall, PolicyContext, RuleBehavior, SourcedRule } from './types.js'

/** A rule with its text read. */
export interface Prepared {
  rule: SourcedRule
  target: RuleTarget
}

const parsed = new Map<string, RuleTarget>()
const PARSED_MAX = 5000

function targetOf(text: string): RuleTarget {
  const known = parsed.get(text)
  if (known !== undefined) {
    return known
  }
  const target = parseRule(text)
  if (parsed.size >= PARSED_MAX) {
    parsed.clear()
  }
  parsed.set(text, target)
  return target
}

export const prepare = (rules: readonly SourcedRule[]): Prepared[] =>
  rules.map((rule) => ({ rule, target: targetOf(rule.text) }))

const ALIASES: Record<string, string> = { Task: 'Agent' }
const nameOf = (call: PolicyCall) => ALIASES[call.name] ?? call.name

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'LS', 'Glob', 'Grep'])
/** A `Read` deny also stops these tools writing the path, as in Claude Code. */
const READ_DENY_WRITERS = new Set(['Edit', 'Write', 'MultiEdit'])

/** Whether a bare tool rule names the call; `Edit` covers every editing tool. */
function namesTool(name: string, call: PolicyCall, behavior: RuleBehavior): boolean {
  const own = nameOf(call)
  if (name === 'Edit') {
    return EDIT_TOOLS.has(own)
  }
  if (name === 'Read' && behavior !== 'allow') {
    return READ_TOOLS.has(own)
  }
  return name === own
}

/** Whether a path rule covers the call: any path for deny and ask, every path for allow. */
function coversPaths(paths: readonly string[], pattern: string, behavior: RuleBehavior, scope: PathScope): boolean {
  const absolute = paths.map((given) => resolvePath(given, scope.cwd, scope.home))
  const covered = (target: string) => pathMatches(pattern, target, behavior, scope)
  return absolute.length > 0 && (behavior === 'allow' ? absolute.every(covered) : absolute.some(covered))
}

function pathRule(
  target: Extract<RuleTarget, { type: 'path' }>,
  call: PolicyCall,
  behavior: RuleBehavior,
  scope: PathScope,
) {
  const name = nameOf(call)
  if (target.tool === 'Edit') {
    return EDIT_TOOLS.has(name) && coversPaths(call.writes, target.pattern, behavior, scope)
  }
  if (READ_TOOLS.has(name)) {
    return coversPaths(call.reads, target.pattern, behavior, scope)
  }
  return behavior === 'deny' && READ_DENY_WRITERS.has(name) && coversPaths(call.writes, target.pattern, behavior, scope)
}

function mcpRule(target: Extract<RuleTarget, { type: 'mcp' }>, call: PolicyCall): boolean {
  if (call.mcp?.server !== target.server) {
    return false
  }
  return target.tool === null || nameMatches(target.tool, call.mcp.tool)
}

/** Rules matched by name or parameter; an allow rule never matches this way but for a subagent. */
function looseMatch(target: RuleTarget, call: PolicyCall, strict: boolean): boolean {
  if (target.type === 'agent') {
    return nameOf(call) === 'Agent' && call.agentType !== undefined && nameMatches(target.pattern, call.agentType)
  }
  if (strict) {
    return false
  }
  if (target.type === 'tool-glob') {
    return nameMatches(target.glob, call.name)
  }
  if (target.type === 'param') {
    return nameOf(call) === target.tool && valueMatches(target.value, call.params[target.key])
  }
  return target.type === 'opaque' && nameOf(call) === target.name
}

/**
 * Whether a rule matches a call, shell commands aside. Deny and ask rules match broadly, by name
 * glob, parameter or a pattern Seti cannot read; allow rules only by what they name exactly.
 */
export function matchesCall(prepared: Prepared, call: PolicyCall, ctx: PolicyContext): boolean {
  const { target, rule } = prepared
  if (target.type === 'tool') {
    return namesTool(target.name, call, rule.behavior)
  }
  if (target.type === 'path') {
    return pathRule(target, call, rule.behavior, { anchor: rule.anchor, cwd: ctx.cwd, home: ctx.home })
  }
  if (target.type === 'domain') {
    return nameOf(call) === 'WebFetch' && call.url !== undefined && domainMatches(target.pattern, call.url)
  }
  if (target.type === 'mcp') {
    return mcpRule(target, call)
  }
  return looseMatch(target, call, rule.behavior === 'allow')
}

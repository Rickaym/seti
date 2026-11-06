import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'

/**
 * What a rule does with a tool call it matches. Deny beats ask and ask beats allow, wherever each
 * rule comes from, so an agent's own allow never lifts a global deny.
 */
export const PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny'] as const
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number]

/** A rule in Claude Code's syntax: a tool name, optionally with what it matches in parentheses. */
const RULE = /^[A-Za-z][\w-]*(\((?=.*\)$)[^\0\n\r]+\))?$/
const RULE_MAX = 500

export const permissionRuleText = z
  .string()
  .trim()
  .max(RULE_MAX)
  .regex(RULE, 'Use a tool name such as Read or mcp__server, or one with a pattern, such as Bash(git status:*)')

/** A rule the user added; `task_id` null applies to every agent. */
export interface PermissionRule {
  id: number
  task_id: string | null
  behavior: PermissionBehavior
  rule: string
  created_at: string
}

/** Which agents a built-in rule applies to. */
export type BuiltInScope = 'all' | 'sandboxed' | 'unsandboxed'

/** A rule Seti applies on its own, which the settings page lists but cannot remove. */
export interface BuiltInRule {
  behavior: PermissionBehavior
  rule: string
  applies: BuiltInScope
}

/**
 * A rule from Claude Code's own settings files, which agents load too; Seti shows it but only
 * the file changes it.
 */
export interface InheritedRule {
  behavior: PermissionBehavior
  rule: string
  /** The settings file, with the home directory as ~. */
  source: string
}

export interface PermissionPolicy {
  built_in: BuiltInRule[]
  /** Rules every agent loads from the user's own Claude Code settings. */
  inherited: InheritedRule[]
  /** What Seti refuses whatever the rules say, in words, such as rm -rf outside an agent's folders. */
  guards: string[]
  /** Rules for every agent. */
  rules: PermissionRule[]
}

/** The rules of one agent: its own, and the global and built-in ones it runs with. */
export interface AgentPermissions extends PermissionPolicy {
  own: PermissionRule[]
  /** Rules the agent loads from its working directory's Claude Code settings. */
  project: InheritedRule[]
}

export const addPermissionRuleInput = z.object({
  behavior: z.enum(PERMISSION_BEHAVIORS),
  rule: permissionRuleText,
})
export type AddPermissionRuleInput = z.input<typeof addPermissionRuleInput>

const ruleId = z.coerce.number().int().positive()

export const permissionRuleParams = z.object({ rule_id: ruleId })

export const taskPermissionRuleParams = z.object({ id: z.string().trim().min(1), rule_id: ruleId })

export const PERMISSION_REQUEST_STATES = ['pending', 'allowed', 'denied', 'cancelled'] as const
export type PermissionRequestState = (typeof PERMISSION_REQUEST_STATES)[number]

/** A tool call the agent waits on the user to allow or deny. */
export interface PermissionRequest {
  id: string
  task_id: string
  tool_name: string
  /** One line of what the call does, such as its command or file. */
  summary: string
  /** The call's input with secrets redacted, cut to a size the page can show. */
  input: string
  /** Why Claude Code asked, such as a path outside the agent's directories. */
  reason: string | null
  /** The rules Always allow adds; empty when the call has none or must not get one. */
  suggestions: string[]
  state: PermissionRequestState
  /** What the user told the agent with a deny. */
  message: string | null
  created_at: string
  decided_at: string | null
}

export const PERMISSION_DECISIONS = ['allow', 'always', 'deny'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Where Always allow keeps its rule: this agent, or every agent. */
export const PERMISSION_SCOPES = ['agent', 'global'] as const
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

const MESSAGE_MAX = 2000

export const answerPermissionInput = z.object({
  decision: z.enum(PERMISSION_DECISIONS),
  scope: z.enum(PERMISSION_SCOPES).default('agent'),
  /** Told to the agent with a deny. */
  message: z.string().trim().max(MESSAGE_MAX).optional(),
})
export type AnswerPermissionInput = z.input<typeof answerPermissionInput>

export const permissionRequestParams = z.object({ id: z.string().trim().min(1).max(100), request_id: z.uuid() })

const maybeText = (label: string) => orDefault(label, z.string().nullable(), null)

export const permissionRequestSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  tool_name: orDefault('tool_name', z.string(), 'tool'),
  summary: orDefault('summary', z.string(), ''),
  input: orDefault('input', z.string(), ''),
  reason: maybeText('reason'),
  suggestions: orDefault('suggestions', z.array(z.string()), []),
  state: orDefault<PermissionRequestState>('state', z.enum(PERMISSION_REQUEST_STATES), 'cancelled'),
  message: maybeText('message'),
  created_at: z.string(),
  decided_at: maybeText('decided_at'),
}) satisfies ResponseSchema<PermissionRequest>

export const permissionRequestsSchema = lenientArray('permission request', permissionRequestSchema)

const ruleSchema = z.object({
  id: z.number(),
  task_id: z.string().nullable(),
  behavior: z.enum(PERMISSION_BEHAVIORS),
  rule: z.string(),
  created_at: z.string(),
}) satisfies ResponseSchema<PermissionRule>

const builtInSchema = z.object({
  behavior: z.enum(PERMISSION_BEHAVIORS),
  rule: z.string(),
  applies: z.enum(['all', 'sandboxed', 'unsandboxed']),
}) satisfies ResponseSchema<BuiltInRule>

const inheritedSchema = z.object({
  behavior: z.enum(PERMISSION_BEHAVIORS),
  rule: z.string(),
  source: z.string(),
}) satisfies ResponseSchema<InheritedRule>

export const permissionPolicySchema = z.object({
  built_in: lenientArray('built-in rule', builtInSchema),
  inherited: lenientArray('inherited rule', inheritedSchema),
  guards: orDefault('guards', z.array(z.string()), []),
  rules: lenientArray('permission rule', ruleSchema),
}) satisfies ResponseSchema<PermissionPolicy>

export const agentPermissionsSchema = permissionPolicySchema.extend({
  own: lenientArray('agent permission rule', ruleSchema),
  project: lenientArray('project rule', inheritedSchema),
}) satisfies ResponseSchema<AgentPermissions>

/** How long Bypass lasts once the user turns it on, in hours. */
export const BYPASS_HOURS = [2, 8, 24] as const
export type BypassHours = (typeof BYPASS_HOURS)[number]
export const DEFAULT_BYPASS_HOURS: BypassHours = 8

/** Turns an agent's Bypass on for `hours`, or off with null. */
export const setBypassInput = z.object({
  hours: z.union([z.literal(2), z.literal(8), z.literal(24)]).nullable(),
})
export type SetBypassInput = z.infer<typeof setBypassInput>

/** An agent's Bypass after a change, and whether its open process took it now or next turn. */
export interface BypassState {
  bypass_until: string | null
  applied: 'now' | 'next_turn'
}

/** Whether an agent's Bypass is on at `at`, from its `bypass_until`. */
export const bypassOn = (until: string | null, at: number = Date.now()): boolean =>
  until !== null && Date.parse(until) > at

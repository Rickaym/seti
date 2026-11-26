import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'
import { CI_STATES, type CiState } from './prs.js'
import { reviewGapSchema, type ReviewGap } from './review-tools.js'

/**
 * What a rule does with a tool call it matches. Deny beats ask and ask beats allow, wherever each
 * rule comes from, so an agent's own allow never lifts a global deny. Review holds an MCP tool's
 * call for the user to check and edit before it runs, in Bypass too.
 */
export const PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny', 'review'] as const
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number]

/** The behaviors Claude Code applies itself; Seti applies review with a hook. */
export type ClaudeBehavior = Exclude<PermissionBehavior, 'review'>

/** A rule in Claude Code's syntax: a tool name, optionally with what it matches in parentheses. */
const RULE = /^[A-Za-z][\w-]*(\((?=.*\)$)[^\0\n\r]+\))?$/
const RULE_MAX = 500

/** An MCP server, which covers all its tools, or one tool, as in mcp__slack or mcp__slack__send. */
const MCP_RULE = /^mcp__[\w-]+$/

/** An allow rule for pushes to one owner outside the user's organisations, as in PushTo(acme). */
const PUSH_RULE = /^PushTo\(([\w.-]+)\)$/

/** The owner a `PushTo` rule names, or null for any other rule. */
export const pushRuleOwner = (rule: string): string | null => PUSH_RULE.exec(rule)?.[1] ?? null

const PUSH_HINT = 'PushTo takes one owner and only allows, such as PushTo(acme)'

/** A rule may name PushTo only as an allow of one owner. */
const pushRuleFits = (behavior: string, rule: string) =>
  !rule.startsWith('PushTo') || (behavior === 'allow' && pushRuleOwner(rule) !== null)

const REVIEW_HINT =
  'Review takes an MCP tool or server, such as mcp__slack__send_message or mcp__slack; use Ask for other tools such as Bash'

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
  behavior: ClaudeBehavior
  rule: string
  applies: BuiltInScope
}

/**
 * A rule from Claude Code's own settings files, which agents load too; Seti shows it but only
 * the file changes it.
 */
export interface InheritedRule {
  behavior: ClaudeBehavior
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
  /** Servers the scope's review rules cover in part, with tools that write or send left out. */
  review_gaps: ReviewGap[]
}

/** The rules of one agent: its own, and the global and built-in ones it runs with. */
export interface AgentPermissions extends PermissionPolicy {
  own: PermissionRule[]
  /** Rules the agent loads from its working directory's Claude Code settings. */
  project: InheritedRule[]
}

export const addPermissionRuleInput = z
  .object({
    behavior: z.enum(PERMISSION_BEHAVIORS),
    rule: permissionRuleText,
  })
  .refine((input) => input.behavior !== 'review' || MCP_RULE.test(input.rule), {
    message: REVIEW_HINT,
    path: ['rule'],
  })
  .refine((input) => pushRuleFits(input.behavior, input.rule), { message: PUSH_HINT, path: ['rule'] })
export type AddPermissionRuleInput = z.input<typeof addPermissionRuleInput>

const BATCH_MAX = 300

/** Several rules of one behavior, added with one confirm. */
export const addPermissionRulesInput = z
  .object({
    behavior: z.enum(PERMISSION_BEHAVIORS),
    rules: z.array(permissionRuleText).min(1).max(BATCH_MAX),
  })
  .refine((input) => input.behavior !== 'review' || input.rules.every((rule) => MCP_RULE.test(rule)), {
    message: REVIEW_HINT,
    path: ['rules'],
  })
  .refine((input) => input.rules.every((rule) => pushRuleFits(input.behavior, rule)), {
    message: PUSH_HINT,
    path: ['rules'],
  })
export type AddPermissionRulesInput = z.input<typeof addPermissionRulesInput>

const ruleId = z.coerce.number().int().positive()

export const permissionRuleParams = z.object({ rule_id: ruleId })

export const taskPermissionRuleParams = z.object({ id: z.string().trim().min(1), rule_id: ruleId })

export const PERMISSION_REQUEST_STATES = ['pending', 'allowed', 'denied', 'cancelled'] as const
export type PermissionRequestState = (typeof PERMISSION_REQUEST_STATES)[number]

/**
 * Why Seti asks: a call no rule allows, a call the agent repeats with the same result, or an MCP
 * call a review rule holds for the user to check.
 */
export const PERMISSION_REQUEST_KINDS = ['tool', 'repeat', 'review'] as const
export type PermissionRequestKind = (typeof PERMISSION_REQUEST_KINDS)[number]

/** A GitHub pull request a request's command names, with its title and CI once Seti knows them. */
export interface RequestPr {
  /** Built by Seti from the repository and number, never taken from the command's text. */
  url: string
  /** `owner/repo`. */
  repo: string
  number: number
  title: string | null
  ci: CiState | null
}

/** A tool call the agent waits on the user to allow or deny. */
export interface PermissionRequest {
  id: string
  task_id: string
  tool_name: string
  kind: PermissionRequestKind
  /** One line of what the call does, such as its command or file. */
  summary: string
  /** The call's input with secrets redacted, cut to a size the page can show. */
  input: string
  /** Why Claude Code asked, such as a path outside the agent's directories. */
  reason: string | null
  /** The rules Always allow adds; empty when the call has none or must not get one, as a repeat. */
  suggestions: string[]
  /** Whether the user may edit the call's text fields before allowing it: unredacted MCP calls. */
  editable: boolean
  /** The pull requests the call's command names; empty for any other call. */
  prs: RequestPr[]
  state: PermissionRequestState
  /** What the user told the agent with a deny. */
  message: string | null
  /** The names of the fields the user edited before they answered; never their text. */
  edited: string[]
  created_at: string
  decided_at: string | null
  /** When Seti denies the request if nobody answers; null while the timeout is off. */
  timeout_at: string | null
  /** Whether the denial came from the timeout, not from the user. */
  timed_out: boolean
}

export const PERMISSION_DECISIONS = ['allow', 'always', 'deny'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Where Always allow keeps its rule: this agent, or every agent. */
export const PERMISSION_SCOPES = ['agent', 'global'] as const
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

const MESSAGE_MAX = 2000
const FIELD_MAX = 100_000
const FIELDS_MAX = 50

export const answerPermissionInput = z.object({
  decision: z.enum(PERMISSION_DECISIONS),
  scope: z.enum(PERMISSION_SCOPES).default('agent'),
  /** Told to the agent with a deny. */
  message: z.string().trim().max(MESSAGE_MAX).optional(),
  /**
   * New values for an editable call's top-level text fields, by name; an allow runs with them and a
   * deny shows them to the agent.
   */
  fields: z
    .record(z.string().max(200), z.string().max(FIELD_MAX))
    .refine((fields) => Object.keys(fields).length <= FIELDS_MAX, 'Too many fields')
    .optional(),
})
export type AnswerPermissionInput = z.input<typeof answerPermissionInput>

export const permissionRequestParams = z.object({ id: z.string().trim().min(1).max(100), request_id: z.uuid() })

const maybeText = (label: string) => orDefault(label, z.string().nullable(), null)

const requestPrSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: maybeText('title'),
  ci: orDefault<CiState | null>('ci', z.enum(CI_STATES).nullable(), null),
}) satisfies ResponseSchema<RequestPr>

/** The PRs a request names, as stored and sent. */
export const requestPrsSchema = z.array(requestPrSchema)

export const permissionRequestSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  tool_name: orDefault('tool_name', z.string(), 'tool'),
  kind: orDefault<PermissionRequestKind>('kind', z.enum(PERMISSION_REQUEST_KINDS), 'tool'),
  summary: orDefault('summary', z.string(), ''),
  input: orDefault('input', z.string(), ''),
  reason: maybeText('reason'),
  suggestions: orDefault('suggestions', z.array(z.string()), []),
  editable: orDefault('editable', z.boolean(), false),
  prs: orDefault('prs', requestPrsSchema, []),
  state: orDefault<PermissionRequestState>('state', z.enum(PERMISSION_REQUEST_STATES), 'cancelled'),
  message: maybeText('message'),
  edited: orDefault('edited', z.array(z.string()), []),
  created_at: z.string(),
  decided_at: maybeText('decided_at'),
  timeout_at: maybeText('timeout_at'),
  timed_out: orDefault('timed_out', z.boolean(), false),
}) satisfies ResponseSchema<PermissionRequest>

export const permissionRequestsSchema = lenientArray('permission request', permissionRequestSchema)

const ruleSchema = z.object({
  id: z.number(),
  task_id: z.string().nullable(),
  behavior: z.enum(PERMISSION_BEHAVIORS),
  rule: z.string(),
  created_at: z.string(),
}) satisfies ResponseSchema<PermissionRule>

export const CLAUDE_BEHAVIORS = ['allow', 'ask', 'deny'] as const satisfies readonly ClaudeBehavior[]

const builtInSchema = z.object({
  behavior: z.enum(CLAUDE_BEHAVIORS),
  rule: z.string(),
  applies: z.enum(['all', 'sandboxed', 'unsandboxed']),
}) satisfies ResponseSchema<BuiltInRule>

const inheritedSchema = z.object({
  behavior: z.enum(CLAUDE_BEHAVIORS),
  rule: z.string(),
  source: z.string(),
}) satisfies ResponseSchema<InheritedRule>

export const permissionPolicySchema = z.object({
  built_in: lenientArray('built-in rule', builtInSchema),
  inherited: lenientArray('inherited rule', inheritedSchema),
  guards: orDefault('guards', z.array(z.string()), []),
  rules: lenientArray('permission rule', ruleSchema),
  review_gaps: lenientArray('review gap', reviewGapSchema),
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

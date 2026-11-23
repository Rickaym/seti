/** How the agent runs: rules first, then this mode decides what no rule decided. */
export type PolicyMode = 'ask' | 'auto' | 'bypass' | 'plan'

export type RuleBehavior = 'allow' | 'ask' | 'deny' | 'review'

/** What a call does, whatever the runtime names its tool. */
export type PolicyKind =
  'shell' | 'read' | 'search' | 'edit' | 'web' | 'mcp' | 'subagent' | 'question' | 'plan' | 'other'

/** One tool call as the evaluator reads it: the parts rules match, never the whole input. */
export interface PolicyCall {
  /** The runtime's tool name, which bare rules such as `Skill` match. */
  name: string
  kind: PolicyKind
  /** The command line of a shell call that runs one. */
  command?: string
  /** A shell call that keeps a terminal open for later input, which no wildcard rule approves. */
  interactive?: boolean
  /** Paths the call reads or searches, as given. */
  reads: string[]
  /** Paths the call writes, as given. */
  writes: string[]
  url?: string
  mcp?: { server: string; tool: string }
  /** The subagent type a subagent call starts. */
  agentType?: string
  /** The call's top-level scalar fields, for `Tool(param:value)` deny and ask rules. */
  params: Record<string, unknown>
}

/** A rule with where it came from; `ref` names it in records without its text. */
export interface SourcedRule {
  behavior: RuleBehavior
  text: string
  ref: string
  /** The directory a `/path` pattern of this rule starts from. */
  anchor: string
}

export interface PolicyContext {
  mode: PolicyMode
  rules: readonly SourcedRule[]
  /** The primary working directory. */
  cwd: string
  /** Every working directory, the primary one included. */
  dirs: readonly string[]
  home: string
  /**
   * Whether the runtime has a classifier that `defer` hands calls to. Without one, Seti reads
   * shell commands itself against a small read-only list and asks where it would defer.
   */
  classifier: boolean
  /** Seti's guards: why the call is refused whatever the rules say, or null. */
  guard?: (call: PolicyCall) => string | null
}

/** `defer` hands the call to the runtime's own classifier; a runtime without one asks. */
export type Verdict = 'allow' | 'deny' | 'ask' | 'review' | 'defer'

export type DecisionStep =
  | 'guard'
  | 'deny-rule'
  | 'review-rule'
  | 'ask-rule'
  | 'question'
  | 'plan'
  | 'safety'
  | 'allow-rule'
  | 'read-only'
  | 'mode'

export interface Decision {
  verdict: Verdict
  step: DecisionStep
  /** The deciding rule's ref, or null when no rule decided. */
  rule: string | null
  reason: string
}

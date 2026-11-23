import { z } from 'zod'

/** The days a shadow summary covers unless asked otherwise, today included. */
export const POLICY_SHADOW_DAYS = 7

/** How many days back a shadow summary counts, today included. */
export const policyShadowQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(POLICY_SHADOW_DAYS),
})

/** Calls where Seti's own decision and Claude Code's differed, counted by what kind and why. */
export interface PolicyShadowDifference {
  /** `looser`: Seti would allow what Claude Code stopped; `tighter`: the reverse. */
  result: 'looser' | 'tighter'
  kind: string
  /** The tool's name, or `mcp` for any tool-server tool. */
  tool: string
  mode: string
  /** Seti's verdict and the step of its evaluation that gave it. */
  verdict: string
  step: string
  /** The deciding rule's ref, such as `rule:12`, or '' when no rule decided. */
  rule: string
  /** What Claude Code did: `allow`, `ask` or `deny`. */
  runtime: string
  calls: number
}

/**
 * How Seti's own permission evaluator, run in shadow, compared with Claude Code on every call
 * since the day: counts only, never a call's input or a rule's text.
 */
export interface PolicyShadowSummary {
  since: string
  /** Calls by result: agree, deferred, tighter, looser, seti-hook, unobserved, interrupted, failed. */
  results: Record<string, number>
  /** Decisions that took longer than they should, whatever their result. */
  slow: number
  /** The most frequent differences, most calls first. */
  differences: PolicyShadowDifference[]
}

/** The first day a summary of the last `days` days counts, as `YYYY-MM-DD` in UTC. */
export const shadowSince = (days: number, now: Date = new Date()): string =>
  new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)

import type { BuiltInRule, InheritedRule, PermissionRule } from '@seti/shared'
import { appliesTo } from '../permission-policy.js'
import type { SourcedRule } from './types.js'

/** Every rule an agent runs with, by source, as `permissionSettings` gathers them. */
export interface RuleSources {
  builtIn: readonly BuiltInRule[]
  sandboxed: boolean
  /** The allow rule for edits in the agent's workspace. */
  workspace: string
  /** Global rules, then the agent's own, review rules included. */
  stored: readonly Pick<PermissionRule, 'id' | 'behavior' | 'rule'>[]
  /** Deny rules Seti keeps whatever the user adds, such as for credentials. */
  fixedDeny: readonly string[]
  /** Rules from Claude Code's settings files, each with where its `/path` patterns start. */
  inherited: readonly (InheritedRule & { anchor: string })[]
  /** The primary working directory, where Seti's own `/path` patterns start. */
  cwd: string
}

/**
 * The rules as the evaluator reads them, each with a ref that names it without its text where
 * the text is the user's: a stored rule by id, a settings file's rule by scope and position.
 */
export function sourcedRules(sources: RuleSources): SourcedRule[] {
  const own = (behavior: SourcedRule['behavior'], text: string, ref: string): SourcedRule => ({
    behavior,
    text,
    ref,
    anchor: sources.cwd,
  })
  return [
    ...sources.builtIn
      .filter((rule) => appliesTo(rule, sources.sandboxed))
      .map((rule) => own(rule.behavior, rule.rule, `builtin:${rule.behavior}:${rule.rule}`)),
    own('allow', sources.workspace, 'workspace'),
    ...sources.stored.map((rule) => own(rule.behavior, rule.rule, `rule:${String(rule.id)}`)),
    ...sources.fixedDeny.map((text, i) => own('deny', text, `fixed:${String(i)}`)),
    ...sources.inherited.map((rule, i) => ({
      behavior: rule.behavior,
      text: rule.rule,
      ref: `inherited:${rule.anchor === sources.cwd ? 'project' : 'user'}:${String(i)}`,
      anchor: rule.anchor,
    })),
  ]
}

import { claudeToolCall, type PermissionRule } from '@seti/shared'
import { guardCommand, type GuardScope } from '../permission-guard.js'
import { builtInRules } from '../permission-policy.js'
import { decide } from './evaluate.js'
import { sourcedRules } from './sources.js'
import { policyCall } from './tool-call.js'
import type { Decision, PolicyContext, PolicyMode } from './types.js'

export const HOME = '/home/me'
export const CWD = '/home/me/work/app'
export const WORKSPACE = '/home/me/.seti/workspaces/t1'

/** The credential folders Seti denies to every agent, as `permissionSettings` writes them. */
const FIXED_DENY = ['.ssh', '.aws', '.config'].flatMap((dir) => [
  `Read(//home/me/${dir})`,
  `Read(//home/me/${dir}/**)`,
  `Edit(//home/me/${dir})`,
  `Edit(//home/me/${dir}/**)`,
])

export interface Setup {
  sandboxed?: boolean
  mode?: PolicyMode
  /** Stored rules as `behavior rule` pairs, given ids in order. */
  rules?: readonly (readonly [PermissionRule['behavior'], string])[]
  /** Rules from the user's Claude Code settings, anchored at `~/.claude`. */
  inherited?: readonly (readonly ['allow' | 'ask' | 'deny', string])[]
  /** Whether Seti's shell guard runs, as it does for every agent. */
  guard?: boolean
  /** Whether the runtime has a classifier, as Claude Code does; true unless set. */
  classifier?: boolean
}

/** An agent's context as Seti builds it: built-in, workspace, stored, fixed and inherited rules. */
export function contextOf(setup: Setup = {}): PolicyContext {
  const sandboxed = setup.sandboxed ?? true
  const scope: GuardScope = { home: HOME, roots: [CWD, WORKSPACE], protectedDirs: [`${HOME}/.ssh`], sandboxed }
  const rules = sourcedRules({
    builtIn: builtInRules(),
    sandboxed,
    workspace: `Edit(/${WORKSPACE}/**)`,
    stored: (setup.rules ?? []).map(([behavior, rule], i) => ({ id: i + 1, behavior, rule })),
    fixedDeny: FIXED_DENY,
    inherited: (setup.inherited ?? []).map(([behavior, rule]) => ({
      behavior,
      rule,
      source: '~/.claude/settings.json',
      anchor: `${HOME}/.claude`,
    })),
    cwd: CWD,
  })
  return {
    mode: setup.mode ?? 'auto',
    rules,
    cwd: CWD,
    dirs: [CWD, WORKSPACE],
    home: HOME,
    classifier: setup.classifier ?? true,
    ...(setup.guard === true
      ? { guard: (call) => (call.command === undefined ? null : guardCommand(call.command, scope)) }
      : {}),
  }
}

/** A Claude Code tool call as the evaluator reads it. */
export const claudeCall = (tool: string, input: Record<string, unknown>) =>
  policyCall(claudeToolCall('toolu_1', tool, input))

/** Seti's decision on a Claude Code tool call in the given setup. */
export const decideClaude = (tool: string, input: Record<string, unknown>, setup: Setup = {}): Decision =>
  decide(claudeCall(tool, input), contextOf(setup))

export const bash = (command: string, setup: Setup = {}) => decideClaude('Bash', { command }, setup)

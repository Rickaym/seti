import { bypassOn, type Task } from '@seti/shared'
import { approvalCeilings } from './store/approval-ceilings.js'
import { codexSettings } from './store/codex-settings.js'

/**
 * Who settles the tool calls no guard or rule refuses, strictest first. `user`: the user answers
 * each one. `rules`: allow rules and the built-in allows run a call, the user answers the rest.
 * `classifier`: as `rules`, then a classifier runs or refuses the rest. `bypass`: calls no rule
 * decides run unasked.
 */
export type ApprovalRegime = 'user' | 'rules' | 'classifier' | 'bypass'

/**
 * The regime an agent-started agent may not go beyond: `codex`, the regime of a Codex agent
 * (`user` while "Rules decide" is off, `rules` while it is on), or none.
 */
export type ApprovalCeiling = 'codex'

/** What decides where an agent sits: its runtime, its Bypass, its ceiling and the Codex setting. */
export interface RegimeFacts {
  runtime: Task['runtime']
  bypass: boolean
  ceiling: ApprovalCeiling | null
  rulesDecide: boolean
}

const codexRegime = (rulesDecide: boolean): ApprovalRegime => (rulesDecide ? 'rules' : 'user')

/**
 * Where an agent's approvals sit. A Codex agent asks Seti about every call; a Claude agent runs
 * Claude Code's `auto` mode unless a ceiling holds it to Codex's regime; Bypass is the user's.
 */
export function regimeOf(facts: RegimeFacts): ApprovalRegime {
  if (facts.runtime === 'codex') {
    return codexRegime(facts.rulesDecide)
  }
  if (facts.bypass) {
    return 'bypass'
  }
  return facts.ceiling === null ? 'classifier' : codexRegime(facts.rulesDecide)
}

/**
 * The ceiling an agent hands to the agents it starts, so none settles calls more loosely than it
 * does: a Codex agent, or one held to Codex's regime, hands on Codex's. Bypass never passes on.
 */
export const ceilingFrom = (caller: Pick<RegimeFacts, 'runtime' | 'ceiling'>): ApprovalCeiling | null =>
  caller.runtime === 'codex' || caller.ceiling === 'codex' ? 'codex' : null

/** The ceiling the agent passes on, read from the store. */
export async function ceilingOf(caller: Pick<Task, 'id' | 'runtime'>): Promise<ApprovalCeiling | null> {
  return ceilingFrom({ runtime: caller.runtime, ceiling: await approvalCeilings.get(caller.id) })
}

/** Where the agent's approvals sit now, from the store and the Codex setting. */
export async function regimeOfTask(task: Pick<Task, 'id' | 'runtime' | 'bypass_until'>): Promise<ApprovalRegime> {
  const [ceiling, settings] = await Promise.all([approvalCeilings.get(task.id), codexSettings.get()])
  return regimeOf({
    runtime: task.runtime,
    bypass: bypassOn(task.bypass_until),
    ceiling,
    rulesDecide: settings.evaluator_decides,
  })
}

/** The line an agent's start records, in its settings and in its creation audit event. */
export const ceilingNote = (caller: string) =>
  `Approvals: held to a Codex agent's, as ${caller} started it: no classifier decides its calls; Seti's rules run them while Codex's "Rules decide" is on, else you answer each one`

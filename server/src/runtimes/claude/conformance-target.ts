import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { claudeToolCall } from '@seti/shared'
import type { ConformanceTarget, NeutralHost } from '../conformance/target.js'
import { claudeAdapter } from './adapter.js'
import { claudeRig, type QuerySlot } from './conformance-rig.js'
import { claudeOneShot } from './one-shot.js'
import type { ClaudeShapes } from './session.js'

/** Claude Code's permission callback, answered by the neutral host. */
const decideWith =
  (neutral: NeutralHost): CanUseTool =>
  async (toolName, input, options) => {
    const call = claudeToolCall(options.toolUseID, toolName, input)
    if (call.kind === 'question') {
      const answers = await neutral.ask(call.question?.questions ?? [], options.signal)
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }
    const decision = await neutral.decide(call, options.signal)
    return decision.allow
      ? { behavior: 'allow', updatedInput: decision.input ?? input }
      : { behavior: 'deny', message: decision.message }
  }

/** The Claude adapter as the suite drives it, over `FakeSdk` behind the slot the mock routes to. */
export const claudeTarget = (slot: QuerySlot): ConformanceTarget<ClaudeShapes, 'claude'> => ({
  adapter: claudeAdapter,
  profile: {
    events: { turnStart: false, reasoning: true, threads: true, plan: true, compaction: true, modelFallback: true },
    usage: { tokens: true, costUsd: 'reported' },
    input: { steer: 'next_step', retract: true, reports: true },
    background: { jobs: true, stop: true, subagents: true },
    gated: { shell: true, edit: true, mcp: true },
    parsesOutput: false,
  },
  gaps: {
    'PM-3':
      'a call Seti denied through canUseTool comes back as a tool_result with is_error and the ' +
      'message, the same as a failed call, so tool.ended says error',
    'INT-1':
      "Claude Code's result after an interrupt is error_during_execution with no mark of the " +
      'interrupt, which arrives as a separate notice row, so turn.ended says error',
    'EV-4':
      "Claude Code reports the session's running total; the turn's share is worked out after the " +
      'adapter (store/cost.ts), so turn.ended carries no cost',
  },
  host: (neutral) => ({ decide: decideWith(neutral), hooks: {}, toolServers: {} }),
  rig: (script) => claudeRig(slot, script),
  oneShot: { runner: claudeOneShot, model: 'claude-suite-model' },
})

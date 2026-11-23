import type { ConformanceTarget, NeutralHost } from '../conformance/target.js'
import { codexAdapterFor } from './adapter.js'
import type { CodexDecide } from './approvals.js'
import type { ScriptedResponses } from './conformance-responses.js'
import { codexRig } from './conformance-rig.js'
import type { CodexShapes } from './session.js'

/** Seti's decision for a Codex ask, from the neutral host; a question goes to the user. */
const decideWith =
  (neutral: NeutralHost): CodexDecide =>
  async (call, signal) => {
    if (call.kind === 'question') {
      const answers = await neutral.ask(call.question?.questions ?? [], signal)
      return { allow: true, input: { answers } }
    }
    return neutral.decide(call, signal)
  }

/** Cases the Codex adapter is known to fail, with the reason. */
export const CODEX_GAPS: Partial<Record<string, string>> = {
  'EV-2':
    'Codex answers a call of a tool it does not offer, or of a tool server it was not given, ' +
    'without an item, so the call has no start or end',
  'EV-4':
    'Codex reports tokens per model call (thread/tokenUsage/updated), not on the turn end; ' +
    'Seti adds them up when it stores the turn',
  'TL-1': 'Codex has no read, search or web tools: reads, searches and fetches are shell commands',
  'TL-3': 'the adapter gives Codex no tool servers yet, so a tool server call has no item',
  'PM-2': 'the adapter gives Codex no tool servers yet, so no tool server call reaches the host',
  'PM-3': "Codex's approval reply carries no message: the model reads Codex's own refusal",
  'INT-3': 'a command still running when its turn ends is not reported as a background job yet',
  'INT-6': 'the adapter cannot stop a background terminal yet',
  'TL-4': 'a command still running when its turn ends is not reported as a background job yet',
  'Q-1': 'questions through request_user_input are not played by the rig yet',
  'Q-2': 'questions through request_user_input are not played by the rig yet',
  'RP-2': "the rig does not play Codex's collaboration agents yet",
  'SA-1': "the rig does not play Codex's collaboration agents yet",
  'PL-1': 'the tools this Codex version offers the model include no plan tool',
  'CP-1': 'the rig does not make Codex compact yet',
}

/** Where the suite runs Codex: its binary, the scripted model, and a folder for the rigs' homes. */
export interface CodexBench {
  binary: string
  model: ScriptedResponses
  baseUrl: string
  folder: string
}

/** The Codex adapter as the suite drives it, over the real binary and a scripted model. */
export const codexTarget = (bench: CodexBench): ConformanceTarget<CodexShapes, 'codex'> => ({
  adapter: codexAdapterFor(bench.binary, { baseUrl: bench.baseUrl, envKey: 'OPENAI_API_KEY' }),
  // A real binary on a busy machine takes seconds where an in-process fake takes milliseconds.
  boundMs: 8000,
  profile: {
    events: { turnStart: true, reasoning: true, threads: true, plan: true, compaction: true, modelFallback: false },
    usage: { tokens: true, costUsd: 'priced' },
    input: { steer: 'next_step', retract: false, reports: true },
    background: { jobs: true, stop: true, subagents: false },
    gated: { shell: true, edit: true, mcp: true },
    parsesOutput: true,
  },
  gaps: CODEX_GAPS,
  host: (neutral) => ({ decide: decideWith(neutral), hooks: null, toolServers: {} }),
  rig: (script) => codexRig(bench.model, bench.folder, script),
})

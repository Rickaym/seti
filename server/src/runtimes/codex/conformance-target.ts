import { openToolRelay } from '../../tool-relay.js'
import type { RuntimeAdapter } from '../adapter.js'
import type { ConformanceTarget, NeutralHost } from '../conformance/target.js'
import { codexAdapterFor } from './adapter.js'
import type { CodexDecide } from './approvals.js'
import type { ScriptedResponses } from './conformance-responses.js'
import { codexRig } from './conformance-rig.js'
import { rigTools } from './conformance-tools.js'
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
  'EV-2': 'Codex answers a call of a tool it does not offer without an item, so the call has no start or end',
  'EV-4':
    'Codex reports tokens per model call (thread/tokenUsage/updated), not on the turn end; ' +
    'Seti adds them up when it stores the turn',
  'TL-1': 'Codex has no read, search or web tools: reads, searches and fetches are shell commands',
  'PM-2':
    "Codex reports an edit's path joined to the working folder, not as the model wrote it; " +
    'the tool server call reaches the host before it runs',
  'PM-3': "Codex's approval reply carries no message: the model reads Codex's own refusal",
  'INT-3':
    'Codex sends nothing when a command moves to the background, so the adapter learns of a job ' +
    "only at its turn's end, after the interrupt this case sends",
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

/** The adapter, given the rig's tool servers through Seti's relay as a session host gives its own. */
function withRigTools(adapter: RuntimeAdapter<CodexShapes, 'codex'>): RuntimeAdapter<CodexShapes, 'codex'> {
  return {
    ...adapter,
    realise: async (spec, launcher, host, abortController) => {
      const tools = rigTools(launcher)
      const toolServers =
        tools === undefined ? {} : await openToolRelay(tools.place, tools.servers, abortController.signal)
      return adapter.realise(spec, launcher, { ...host, toolServers }, abortController)
    },
  }
}

/** The Codex adapter as the suite drives it, over the real binary and a scripted model. */
export const codexTarget = (bench: CodexBench): ConformanceTarget<CodexShapes, 'codex'> => ({
  adapter: withRigTools(codexAdapterFor(bench.binary, { baseUrl: bench.baseUrl, envKey: 'OPENAI_API_KEY' })),
  // A real binary on a busy machine takes seconds where an in-process fake takes milliseconds.
  boundMs: 8000,
  profile: {
    // Subagents are off in this version (features.multi_agent), so no subagent thread is reported.
    events: { turnStart: true, reasoning: true, threads: false, plan: true, compaction: true, modelFallback: false },
    usage: { tokens: true, costUsd: 'priced' },
    input: { steer: 'next_step', retract: false, reports: true },
    background: { jobs: true, stop: true, subagents: false },
    gated: { shell: true, edit: true, mcp: true },
    parsesOutput: true,
  },
  gaps: CODEX_GAPS,
  host: (neutral) => ({ decide: decideWith(neutral), hooks: null, toolServers: {} }),
  rig: (script) => codexRig(bench.model, bench.folder, script),
  oneShotModel: 'gpt-5.5',
})

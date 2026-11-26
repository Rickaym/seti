import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { acpAdapterFor } from '../acp/adapter.js'
import type { AcpDecide } from '../acp/permissions.js'
import type { AcpShapes } from '../acp/session.js'
import type { ConformanceTarget, NeutralHost } from '../conformance/target.js'
import { geminiRig, type RigBench } from './conformance-rig.js'

/** Seti's decision for a Gemini CLI ask, from the neutral host. */
const decideWith =
  (neutral: NeutralHost): AcpDecide =>
  async (call, signal) =>
    neutral.decide(call, signal)

/** Cases the ACP adapter over Gemini CLI is known to fail, with the reason. */
const NO_SERVERS = 'the adapter hands Gemini CLI no tool server yet, so no tool server call is made'

export const GEMINI_GAPS: Partial<Record<string, string>> = {
  'LC-2': 'ACP marks no boundary between messages: two text parts in a row arrive as chunks of one message',
  'INT-5': 'ACP cancels a turn with a notification, which has no reply, so the agent cannot refuse it',
  'IN-1': 'ACP marks no message boundary, so the text the case waits for joins the reply that follows it',
  'EV-2': 'Gemini CLI answers a call of a tool it does not offer without any update, so it has no start or end',
  'TL-1':
    'ACP sends no call input: a read names the paths Gemini CLI resolved in the working folder, ' +
    'not the paths the model wrote',
  'TL-2': 'Gemini CLI ends a command that exits non-zero as completed; the exit code is only in the text',
  'TL-3': NO_SERVERS,
  'PM-2': `an edit names its path resolved in the working folder, and ${NO_SERVERS}`,
  'PM-3': "ACP's permission reply carries no message: the model reads Gemini CLI's own refusal",
  'Q-1': `Gemini CLI offers no question tool over ACP; questions come through Seti's tools, and ${NO_SERVERS}`,
  'Q-2': `Gemini CLI offers no question tool over ACP; questions come through Seti's tools, and ${NO_SERVERS}`,
  'DG-1': NO_SERVERS,
  'DG-2': NO_SERVERS,
}

/** Every tool call asks first, reads included, as Seti's admin policy will make it. */
const ADMIN_POLICY = [
  '[[rule]]',
  'toolName = "*"',
  'decision = "ask_user"',
  'priority = 999',
  '[[rule]]',
  'mcpName = "*"',
  'toolName = "*"',
  'decision = "ask_user"',
  'priority = 999',
  '',
].join('\n')

const SYSTEM_SETTINGS = {
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  security: { auth: { selectedType: 'gemini-api-key' }, disableYoloMode: true },
}

/**
 * Where the suite runs Gemini CLI: its program, the model the agents pick, the scripted API that
 * answers for it, and a folder for the rigs' homes and Seti's policy files.
 */
export interface GeminiBench extends RigBench {
  binary: string
  baseUrl: string
  agentModel: string
}

/** The settings a bench launches with; the profile that ships them comes with the install. */
function launchOf(bench: GeminiBench) {
  const policy = path.join(bench.folder, 'admin-policy.toml')
  const settings = path.join(bench.folder, 'system-settings.json')
  writeFileSync(policy, ADMIN_POLICY)
  writeFileSync(settings, JSON.stringify(SYSTEM_SETTINGS))
  return {
    label: 'Gemini CLI',
    command: bench.binary,
    args: (model: string) => ['--acp', '--admin-policy', policy, '-m', model],
    env: {
      GOOGLE_GEMINI_BASE_URL: bench.baseUrl,
      GEMINI_CLI_NO_RELAUNCH: 'true',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_SYSTEM_MD: '0',
    },
    keyVariable: 'GEMINI_API_KEY',
    model: bench.agentModel,
  }
}

/** The ACP adapter as the suite drives it, over the real Gemini CLI and a scripted API. */
export const geminiTarget = (bench: GeminiBench): ConformanceTarget<AcpShapes, 'gemini'> => ({
  adapter: acpAdapterFor('gemini', launchOf(bench)),
  // A real Node program on a busy machine takes seconds to start where a fake takes milliseconds.
  boundMs: 15000,
  profile: {
    events: { turnStart: true, reasoning: true, threads: false, plan: false, compaction: false, modelFallback: false },
    usage: { tokens: true, costUsd: 'none' },
    input: { steer: 'after_turn', retract: false, reports: true },
    background: { jobs: false, stop: false, subagents: false },
    gated: { shell: true, edit: true, mcp: true },
    parsesOutput: true,
  },
  gaps: GEMINI_GAPS,
  host: (neutral) => ({ decide: decideWith(neutral), hooks: null, toolServers: {} }),
  rig: (script) => geminiRig(bench, script),
  oneShotModel: bench.agentModel,
})

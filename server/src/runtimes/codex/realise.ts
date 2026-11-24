import type { Launcher } from '../../launcher.js'
import { MODEL_KEY_ENV } from '../../sandbox-codex.js'
import type { SessionSpec } from '../../session-spec.js'
import type { CodexDecide } from './approvals.js'
import type { CodexRealised } from './session.js'

/** Where Codex sends its model calls, and the variable that holds the key's placeholder. */
export interface CodexProvider {
  baseUrl: string
  envKey: string
}

const PROVIDER = 'seti-openai'

/** OpenAI's API, with the key the egress proxy puts in place of the sandbox's placeholder. */
const OPENAI: CodexProvider = { baseUrl: 'https://api.openai.com/v1', envKey: MODEL_KEY_ENV }

/** The model a Codex agent uses until it picks one; without a model Codex offers no tools. */
const DEFAULT_MODEL = 'gpt-5.5'

const toml = (value: string | boolean) => (typeof value === 'boolean' ? String(value) : JSON.stringify(value))

/**
 * Every setting the app-server runs with, on its command line, which wins over any config file.
 * Terminals for `tty` commands are off, so nothing typed into a running command escapes a
 * decision; hooks, plugins, apps, goals, memories, skills, analytics and hosted web search are
 * off. Commands get no shell snapshot, which every later command would source, and the sandbox's
 * search path, which leaves out the helper folder Codex makes in its writable home. Approvals go
 * to Seti, never to a reviewer model.
 */
function overrides(provider: CodexProvider, model: string, searchPath: string | undefined): string[] {
  const settings: [string, string | boolean][] = [
    ['model', model],
    ['model_provider', PROVIDER],
    [`model_providers.${PROVIDER}.name`, 'OpenAI through Seti'],
    [`model_providers.${PROVIDER}.base_url`, provider.baseUrl],
    [`model_providers.${PROVIDER}.env_key`, provider.envKey],
    [`model_providers.${PROVIDER}.wire_api`, 'responses'],
    ['features.unified_exec_tty', false],
    ['features.default_mode_request_user_input', true],
    ['features.hooks', false],
    ['features.plugins', false],
    ['features.apps', false],
    ['features.remote_plugin', false],
    ['features.image_generation', false],
    ['features.skill_mcp_dependency_install', false],
    ['features.multi_agent', false],
    ['features.multi_agent_v2', false],
    ['features.goals', false],
    ['features.memories', false],
    ['features.shell_snapshot', false],
    ['skills.include_instructions', false],
    ['approvals_reviewer', 'user'],
    ['analytics.enabled', false],
    ['web_search', 'disabled'],
    ...(searchPath === undefined ? [] : [['shell_environment_policy.set.PATH', searchPath] satisfies [string, string]]),
  ]
  return settings.flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])
}

/** What a session's asks are answered by, and the program and provider it runs with. */
interface Answering {
  decide: CodexDecide
  abortController: AbortController
  binary: string
  /** OpenAI's API through the proxy unless a test bench names its own. */
  provider?: CodexProvider
}

/** What starts one app-server: the program, where it works and what answers its asks. */
export function realiseCodex(
  spec: SessionSpec<'codex'>,
  launcher: Launcher,
  { decide, abortController, binary, provider = OPENAI }: Answering,
): CodexRealised {
  if (!launcher.sandboxed || launcher.spawn === undefined) {
    throw new Error("Codex runs only in Seti's sandbox, started through its launcher")
  }
  if (launcher.env[provider.envKey] === undefined) {
    throw new Error('This Codex agent has no OpenAI key: its credential needs a connection for api.openai.com')
  }
  return {
    command: binary,
    args: ['app-server', '--listen', 'stdio://', ...overrides(provider, DEFAULT_MODEL, launcher.env.PATH)],
    cwd: spec.cwd,
    env: { ...launcher.env },
    resume: spec.resume,
    model: DEFAULT_MODEL,
    effort: null,
    spawn: launcher.spawn,
    decide,
    signal: abortController.signal,
  }
}

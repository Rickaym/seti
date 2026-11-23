import type { Launcher } from '../../launcher.js'
import type { SessionSpec } from '../../session-spec.js'
import type { CodexDecide } from './approvals.js'
import type { CodexRealised } from './session.js'

/** Where Codex sends its model calls, and the variable that holds the key's placeholder. */
export interface CodexProvider {
  baseUrl: string
  envKey: string
}

const PROVIDER = 'seti-openai'

/** The model a Codex agent uses until it picks one; without a model Codex offers no tools. */
const DEFAULT_MODEL = 'gpt-5.5'

const toml = (value: string | boolean) => (typeof value === 'boolean' ? String(value) : JSON.stringify(value))

/**
 * Every setting the app-server runs with, on its command line: a config file in the agent's home
 * is writable by the agent, and the command line wins over it. Terminals for `tty` commands are
 * off, so nothing typed into a running command escapes a decision; hooks, plugins, apps,
 * analytics and hosted web search are off.
 */
function overrides(provider: CodexProvider, model: string): string[] {
  const settings: [string, string | boolean][] = [
    ['model', model],
    ['model_provider', PROVIDER],
    [`model_providers.${PROVIDER}.name`, 'OpenAI through Seti'],
    [`model_providers.${PROVIDER}.base_url`, provider.baseUrl],
    [`model_providers.${PROVIDER}.env_key`, provider.envKey],
    [`model_providers.${PROVIDER}.wire_api`, 'responses'],
    ['features.unified_exec_tty', false],
    ['features.hooks', false],
    ['features.plugins', false],
    ['features.apps', false],
    ['features.remote_plugin', false],
    ['features.image_generation', false],
    ['features.skill_mcp_dependency_install', false],
    ['analytics.enabled', false],
    ['web_search', 'disabled'],
  ]
  return settings.flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])
}

/** What a session's asks are answered by, and the program and provider it runs with. */
interface Answering {
  decide: CodexDecide
  abortController: AbortController
  binary: string
  provider: CodexProvider
}

/** What starts one app-server: the program, where it works and what answers its asks. */
export function realiseCodex(
  spec: SessionSpec<'codex'>,
  launcher: Launcher,
  { decide, abortController, binary, provider }: Answering,
): CodexRealised {
  if (!launcher.sandboxed || launcher.spawn === undefined) {
    throw new Error("Codex runs only in Seti's sandbox, started through its launcher")
  }
  return {
    command: binary,
    args: ['app-server', '--listen', 'stdio://', ...overrides(provider, DEFAULT_MODEL)],
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

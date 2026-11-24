import { SHARED_TOOL_SERVER } from '@seti/shared'
import type { Launcher } from '../../launcher.js'
import { MODEL_KEY_ENV } from '../../sandbox-codex.js'
import type { SessionSpec } from '../../session-spec.js'
import { sharedToolCommand } from '../../shared-tools.js'
import type { StdioServer } from '../../tool-relay.js'
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

type Setting = [string, string | boolean | number | string[]]

/** A value as TOML writes it; a JSON string or list of strings is also a TOML one. */
const toml = (value: Setting[1]) =>
  typeof value === 'string' || Array.isArray(value) ? JSON.stringify(value) : String(value)

/** How long one of Seti's tool calls may run, as long as Claude Code agents wait for one. */
const TOOL_TIMEOUT_S = 7 * 24 * 60 * 60

/** Codex reads an MCP server's name as a bare key of its settings. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

/**
 * The tool servers Codex starts: the host's, then the shared tools, which read the agent's
 * connection variables as they do under Claude Code; never the variable of the model's key.
 */
function serverSettings(servers: Record<string, StdioServer>, shared: StdioServer | null, env: string[]): Setting[] {
  const all = Object.entries(servers).map(([name, server]) => ({ name, server, env: [] as string[] }))
  if (shared !== null) {
    all.push({ name: SHARED_TOOL_SERVER, server: shared, env: env.filter((name) => name !== MODEL_KEY_ENV) })
  }
  return all.flatMap(({ name, server, env: passed }): Setting[] => {
    if (!SERVER_NAME.test(name)) {
      throw new Error(`Codex cannot start a tool server named ${JSON.stringify(name)}`)
    }
    const key = `mcp_servers.${name}`
    return [
      [`${key}.command`, server.command],
      [`${key}.args`, server.args],
      [`${key}.tool_timeout_sec`, TOOL_TIMEOUT_S],
      ...(passed.length === 0 ? [] : [[`${key}.env_vars`, passed] satisfies Setting]),
    ]
  })
}

/**
 * Every setting the app-server runs with, on its command line, which wins over any config file.
 * Terminals for `tty` commands are off, so nothing typed into a running command escapes a
 * decision; hooks, plugins, apps, goals, memories, skills, analytics and hosted web search are
 * off. Commands get no shell snapshot, which every later command would source, and the sandbox's
 * search path, which leaves out the helper folder Codex makes in its writable home. Approvals go
 * to Seti, never to a reviewer model.
 */
function overrides(provider: CodexProvider, model: string, searchPath: string | undefined): Setting[] {
  return [
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
    ...(searchPath === undefined ? [] : [['shell_environment_policy.set.PATH', searchPath] satisfies Setting]),
  ]
}

const commandLine = (settings: Setting[]) => settings.flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])

/** What a session's asks are answered by, and the program and provider it runs with. */
interface Answering {
  decide: CodexDecide
  /** Seti's own tool servers, as programs Codex starts inside the sandbox. */
  toolServers: Record<string, StdioServer>
  abortController: AbortController
  binary: string
  /** OpenAI's API through the proxy unless a test bench names its own. */
  provider?: CodexProvider
}

/** What starts one app-server: the program, where it works and what answers its asks. */
export function realiseCodex(
  spec: SessionSpec<'codex'>,
  launcher: Launcher,
  { decide, toolServers, abortController, binary, provider = OPENAI }: Answering,
): CodexRealised {
  if (!launcher.sandboxed || launcher.spawn === undefined) {
    throw new Error("Codex runs only in Seti's sandbox, started through its launcher")
  }
  if (launcher.env[provider.envKey] === undefined) {
    throw new Error('This Codex agent has no OpenAI key: its credential needs a connection for api.openai.com')
  }
  const servers = serverSettings(toolServers, sharedToolCommand(spec.toolServers.shared), Object.keys(launcher.env))
  const model = spec.vendor.model ?? DEFAULT_MODEL
  const settings = [...overrides(provider, model, launcher.env.PATH), ...servers]
  return {
    command: binary,
    args: ['app-server', '--listen', 'stdio://', ...commandLine(settings)],
    cwd: spec.cwd,
    env: { ...launcher.env },
    resume: spec.resume,
    model,
    effort: spec.vendor.effort,
    instructions: spec.instructions.append,
    spawn: launcher.spawn,
    decide,
    signal: abortController.signal,
  }
}

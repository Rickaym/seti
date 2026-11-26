import { PROVIDERS, SHARED_TOOL_SERVER, type CompactRule } from '@seti/shared'
import type { CodexToolServer } from '../../codex-tool-servers.js'
import type { Launcher } from '../../launcher.js'
import { MODEL_KEY_ENV } from '../../sandbox-codex.js'
import type { SessionSpec } from '../../session-spec.js'
import { sharedToolCommand } from '../../shared-tools.js'
import type { StdioServer } from '../../tool-relay.js'
import type { OneShotRequest } from '../one-shot.js'
import type { CodexDecide } from './approvals.js'
import type { CodexRealised } from './session.js'
import { withSkills } from './skills.js'

/** Where Codex sends its model calls, and the variable that holds the key's placeholder. */
export interface CodexProvider {
  baseUrl: string
  envKey: string
}

const PROVIDER = 'seti-openai'

/** OpenAI's API, with the key the egress proxy puts in place of the sandbox's placeholder. */
const OPENAI: CodexProvider = { baseUrl: PROVIDERS.openai.baseUrl, envKey: MODEL_KEY_ENV }

/** The model a Codex agent uses until it picks one; without a model Codex offers no tools. */
const DEFAULT_MODEL = 'gpt-5.5'

type Setting = [string, string | boolean | number | string[]]

/** A value as TOML writes it; a JSON string or list of strings is also a TOML one. */
const toml = (value: Setting[1]) =>
  typeof value === 'string' || Array.isArray(value) ? JSON.stringify(value) : String(value)

/** How long one of Seti's tool calls may run, as long as Claude Code agents wait for one. */
const TOOL_TIMEOUT_S = 7 * 24 * 60 * 60

/** Codex reads an MCP server's name as a bare key of its settings. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** The server names Codex takes, and that rule in words. */
export const SERVER_NAMES = { pattern: SERVER_NAME, rule: 'letters, digits, - and _ only' }

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

/** How long a user's server may take to start, as long as Claude Code waits for one. */
const STARTUP_TIMEOUT_S = 30

/**
 * The user's servers, each of whose tool calls Codex asks Seti about whatever the tool says of
 * itself; a stdio one runs inside the sandbox with the agent's connection variables, never the
 * model key's. A server named like one of Seti's own is left out.
 */
function userServerSettings(
  servers: readonly CodexToolServer[],
  taken: ReadonlySet<string>,
  env: string[],
  keyEnv: string,
): Setting[] {
  const passed = env.filter((name) => name !== MODEL_KEY_ENV && name !== keyEnv)
  return servers
    .filter((server) => !taken.has(server.name) && SERVER_NAME.test(server.name))
    .flatMap((server): Setting[] => {
      const key = `mcp_servers.${server.name}`
      const reach: Setting[] =
        server.transport === 'http'
          ? [[`${key}.url`, server.url]]
          : [
              [`${key}.command`, server.command],
              [`${key}.args`, server.args],
              ...(passed.length === 0 ? [] : [[`${key}.env_vars`, passed] satisfies Setting]),
            ]
      return [
        ...reach,
        [`${key}.default_tools_approval_mode`, 'prompt'],
        [`${key}.startup_timeout_sec`, STARTUP_TIMEOUT_S],
        [`${key}.tool_timeout_sec`, TOOL_TIMEOUT_S],
      ]
    })
}

/** What Codex is told when it compacts, before the rule's own instructions. */
const COMPACT_FRAME = 'Summarize this conversation for the model that continues the work, which sees only your summary.'

/**
 * The parts of a compaction rule Codex takes: a token limit from a context window and Compact
 * at, and the prompt it summarizes with. It compacts near its own limit whatever the rule says.
 */
function compactSettings(rule: CompactRule): Setting[] {
  const { window_k: window, threshold_pct: pct, instructions } = rule
  return [
    ...(window === null || pct === null
      ? []
      : [['model_auto_compact_token_limit', window * 10 * pct] satisfies Setting]),
    ...(instructions === null ? [] : [['compact_prompt', `${COMPACT_FRAME}\n\n${instructions}`] satisfies Setting]),
  ]
}

/**
 * Every setting the app-server runs with, on its command line, which wins over any config file.
 * Terminals for `tty` commands are off, so nothing typed into a running command escapes a
 * decision; hooks, plugins, apps, goals, memories, skills, analytics and hosted web search are
 * off, as are subagents, which newer models' catalog entries turn on unless `agents` is off.
 * Commands get no shell snapshot, which every later command would source, and the sandbox's
 * search path, which leaves out the helper folder Codex makes in its writable home. The model
 * sends a summary of its reasoning, which Seti's models leave out unless asked. Approvals go to
 * Seti, never to a reviewer model. A folder without AGENTS.md gives its CLAUDE.md instead, as
 * a Claude Code agent reads it.
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
    ['agents.enabled', false],
    ['features.goals', false],
    ['features.memories', false],
    ['features.shell_snapshot', false],
    ['skills.include_instructions', false],
    ['model_reasoning_summary', 'auto'],
    ['approvals_reviewer', 'user'],
    ['analytics.enabled', false],
    ['web_search', 'disabled'],
    ['project_doc_fallback_filenames', ['CLAUDE.md']],
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

/** The launcher's spawn, once it is sandboxed and its environment holds the key's placeholder. */
function sandboxedSpawn(launcher: Launcher, provider: CodexProvider) {
  if (!launcher.sandboxed || launcher.spawn === undefined) {
    throw new Error("Codex runs only in Seti's sandbox, started through its launcher")
  }
  if (launcher.env[provider.envKey] === undefined) {
    throw new Error('This Codex agent has no OpenAI key: its credential needs a connection for api.openai.com')
  }
  return launcher.spawn
}

/** What starts one app-server: the program, where it works and what answers its asks. */
export function realiseCodex(
  spec: SessionSpec<'codex'>,
  launcher: Launcher,
  { decide, toolServers, abortController, binary, provider = OPENAI }: Answering,
): CodexRealised {
  const spawn = sandboxedSpawn(launcher, provider)
  const env = Object.keys(launcher.env)
  const shared = sharedToolCommand(spec.toolServers.shared)
  const taken = new Set([...Object.keys(toolServers), SHARED_TOOL_SERVER])
  const servers = [
    ...serverSettings(toolServers, shared, env),
    ...userServerSettings(spec.vendor.servers, taken, env, provider.envKey),
  ]
  const model = spec.vendor.model ?? DEFAULT_MODEL
  const settings = [...overrides(provider, model, launcher.env.PATH), ...compactSettings(spec.compaction), ...servers]
  return {
    command: binary,
    args: ['app-server', '--listen', 'stdio://', ...commandLine(settings)],
    cwd: spec.cwd,
    env: { ...launcher.env },
    resume: spec.resume,
    model,
    effort: spec.vendor.effort,
    instructions: withSkills(spec.instructions.append, spec.vendor.skills, launcher.env.HOME),
    spawn,
    decide,
    signal: abortController.signal,
  }
}

/** What starts a one-shot's app-server: no tool server, a thread kept off disk, its one model. */
export function realiseOneShot(
  request: OneShotRequest,
  launcher: Launcher,
  { decide, abortController, binary, provider = OPENAI }: Omit<Answering, 'toolServers'>,
): CodexRealised {
  const spawn = sandboxedSpawn(launcher, provider)
  return {
    command: binary,
    args: ['app-server', '--listen', 'stdio://', ...commandLine(overrides(provider, request.model, launcher.env.PATH))],
    cwd: request.cwd,
    env: { ...launcher.env },
    resume: null,
    ephemeral: true,
    model: request.model,
    effort: null,
    instructions: request.system,
    spawn,
    decide,
    signal: abortController.signal,
  }
}

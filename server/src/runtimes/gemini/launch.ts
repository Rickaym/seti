import path from 'node:path'
import type { AcpLaunch } from '../acp/adapter.js'

/** Where Gemini CLI sends its model calls; the proxy adds the key on this host only. */
export const GEMINI_API = 'https://generativelanguage.googleapis.com'

/** The model a Gemini session runs when its agent names none. */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash'

/** The variable Gemini CLI reads its API key from: the key connection's placeholder. */
export const GEMINI_KEY_ENV = 'GEMINI_API_KEY'

/** Seti's settings and policy files, by name in the folder `geminiLaunch` is given. */
const SETTINGS = 'settings.json'
const POLICY = 'seti-policy.toml'
const TRUSTED = 'trusted-folders.json'

/**
 * Every tool call asks first, reads and tool server calls included. Given on the command line as
 * the admin policy, it outranks any policy file in the home or the folder.
 */
const ADMIN_POLICY = [
  '[[rule]]',
  'toolName = "*"',
  'decision = "ask_user"',
  'priority = 999',
  '',
  '[[rule]]',
  'mcpName = "*"',
  'toolName = "*"',
  'decision = "ask_user"',
  'priority = 999',
  '',
].join('\n')

/**
 * The system settings, which outrank the home's and the folder's: no usage statistics or
 * telemetry, the API key as the only sign-in, no YOLO or "always allow", no checkpoints, hooks,
 * IDE, own sandbox or updates, and no `.env` read from the working folders.
 */
const SYSTEM_SETTINGS = {
  general: {
    checkpointing: { enabled: false },
    enableAutoUpdate: false,
    enableAutoUpdateNotification: false,
    enableNotifications: false,
  },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false, logPrompts: false },
  ide: { enabled: false },
  tools: { sandbox: false },
  security: {
    auth: { selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key' },
    disableYoloMode: true,
    disableAlwaysAllow: true,
    enablePermanentToolApproval: false,
    autoAddToPolicyByDefault: false,
  },
  advanced: { ignoreLocalEnv: true },
  hooksConfig: { enabled: false },
}

/** The files Seti hands every Gemini CLI process, read-only, by name. */
export const GEMINI_CONFIG_FILES: Readonly<Record<string, string>> = {
  [SETTINGS]: `${JSON.stringify(SYSTEM_SETTINGS, null, 2)}\n`,
  [POLICY]: ADMIN_POLICY,
  [TRUSTED]: '{}\n',
}

/**
 * Variables Gemini CLI reads that would change where it sends calls, how it signs in, what it
 * runs or what it records, unset: a `.env` file Gemini CLI loads never overrides a variable
 * already set, so each one is set empty here. Credential variables stay unset: the sign-in
 * settings and the API key variable below make Gemini CLI ignore them.
 */
const CLEARED = [
  'CLOUD_SHELL',
  'CODE_ASSIST_API_VERSION',
  'CODE_ASSIST_ENDPOINT',
  'GEMINI_CLI_ACTIVITY_LOG_TARGET',
  'GEMINI_CLI_AUTH_OVERRIDE',
  'GEMINI_CLI_CUSTOM_HEADERS',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_IDE_PID',
  'GEMINI_CLI_IDE_SERVER_PORT',
  'GEMINI_CLI_IDE_SERVER_STDIO_ARGS',
  'GEMINI_CLI_IDE_SERVER_STDIO_COMMAND',
  'GEMINI_CLI_IDE_WORKSPACE_PATH',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'GEMINI_CONTEXT_TRACE_DIR',
  'GEMINI_DEBUG_LOG_FILE',
  'GEMINI_EXP',
  'GEMINI_MODEL',
  'GEMINI_RESTRICTED_MODE',
  'GEMINI_SANDBOX_IMAGE',
  'GEMINI_SANDBOX_PROXY_COMMAND',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_VERTEX_BASE_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_PROMETHEUS_HOST',
  'OTEL_EXPORTER_PROMETHEUS_PORT',
  'SANDBOX',
  'SANDBOX_ENV',
  'SANDBOX_FLAGS',
  'SANDBOX_MOUNTS',
  'SANDBOX_PORTS',
  'SEATBELT_PROFILE',
]

/** The environment Seti presets over the sandbox's for Gemini CLI, with its files in `config`. */
export function geminiEnv(config: string, apiUrl: string): Record<string, string> {
  return {
    ...Object.fromEntries(CLEARED.map((name) => [name, ''])),
    GOOGLE_GEMINI_BASE_URL: apiUrl,
    GEMINI_API_KEY_AUTH_MECHANISM: 'x-goog-api-key',
    GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key',
    GOOGLE_GENAI_USE_GCA: 'false',
    GOOGLE_GENAI_USE_VERTEXAI: 'false',
    GEMINI_SANDBOX: 'false',
    GEMINI_SYSTEM_MD: '0',
    GEMINI_CLI_NO_RELAUNCH: 'true',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(config, SETTINGS),
    GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(config, TRUSTED),
  }
}

/** Where one Gemini CLI process comes from: Node, the pinned bundle's entry and Seti's files. */
export interface GeminiProgram {
  node: string
  entry: string
  /** The folder holding `GEMINI_CONFIG_FILES`, as the process sees it. */
  config: string
  /** Where model calls go; the real API but in tests. */
  apiUrl?: string
  model?: string
}

/**
 * How Seti starts Gemini CLI: over ACP, with Seti's admin policy and the model on the command
 * line, and never `--allowed-mcp-server-names`, which would run a server's tools without asking.
 */
export const geminiLaunch = (program: GeminiProgram): AcpLaunch => ({
  label: 'Gemini CLI',
  command: program.node,
  args: (model) => [program.entry, '--acp', '--admin-policy', path.join(program.config, POLICY), '-m', model],
  env: geminiEnv(program.config, program.apiUrl ?? GEMINI_API),
  keyVariable: GEMINI_KEY_ENV,
  model: program.model ?? GEMINI_DEFAULT_MODEL,
})

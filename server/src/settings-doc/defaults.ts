import {
  AUTO_ARCHIVE_DEFAULTS,
  AWS_SETTINGS_DEFAULT,
  CODEX_SETTINGS_DEFAULTS,
  COMPACT_DEFAULTS,
  DEFAULT_PERMISSION_TIMEOUT_MINUTES,
  DEFAULT_PROFILE_ID,
  DEFAULT_TIERS,
  DREAM_SETTINGS_DEFAULTS,
  EA_SETTINGS_DEFAULT,
  SANDBOX_POLICY_DEFAULT,
  STORAGE_SCHEDULE_DEFAULTS,
  type SettingsSectionPath,
  type SettingsSectionValue,
} from '@seti/shared'
import { cpuCapSettings } from '../cpu-cap.js'
import { credentialsOverview } from '../credential-profiles.js'
import { isBorrowed, localServers, readHostConfig } from '../mcp-borrowed.js'
import { memoryCapSettings } from '../memory-cap.js'

/** Each section's defaults, given its current value for the names of the items it lists. */
type SectionDefaults = {
  [P in SettingsSectionPath]: (
    current: SettingsSectionValue<P>,
  ) => SettingsSectionValue<P> | Promise<SettingsSectionValue<P>>
}

const each = <T>(names: Record<string, unknown>, value: (name: string) => T): Record<string, T> =>
  Object.fromEntries(Object.keys(names).map((name) => [name, value(name)]))

const { enabled, days, delete_after_days, resume_after_restart, repeat_guard } = AUTO_ARCHIVE_DEFAULTS
const { wake_enabled, wake_phrase, keep_awake_seconds, join_on_open, form_of_address, language } = EA_SETTINGS_DEFAULT
const codex = CODEX_SETTINGS_DEFAULTS

/** The credential Seti makes at setup, as it starts: no AWS role, no token, nothing carried. */
async function defaultCredential(): Promise<
  Record<string, SettingsSectionValue<'security.credentials'>['credentials'][string]>
> {
  const made = (await credentialsOverview()).profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID)
  if (made === undefined) {
    return {}
  }
  const { role_arn, external_id, region, session_minutes } = AWS_SETTINGS_DEFAULT
  const aws = { role_arn, external_id, region, session_minutes }
  return { [made.name]: { aws, github: { default: 'not set', owners: {} }, connections: [], ssh_hosts: [] } }
}

/** What each setting is until someone changes it; lists of things people add start empty. */
export const SECTION_DEFAULTS: SectionDefaults = {
  'app.general': () => ({ name: null, theme: null }),
  'app.notifications': () => ({ tiers: { ...DEFAULT_TIERS } }),
  'app.ea': () => ({ wake_enabled, wake_phrase, keep_awake_seconds, join_on_open, form_of_address, language }),
  'agents.lifecycle': () => ({
    auto_archive: { enabled, days, delete_after_days, resume_after_restart, repeat_guard },
    compaction: { ...COMPACT_DEFAULTS },
    dreaming: { ...DREAM_SETTINGS_DEFAULTS },
  }),
  'agents.repos': () => ({ repos: {} }),
  'agents.resources': async () => ({
    memory_cap: (await memoryCapSettings()).defaults,
    cpu_cap: (await cpuCapSettings()).defaults,
  }),
  'agents.runtimes': () => ({
    codex: {
      enabled: codex.enabled,
      program: codex.program,
      evaluator_decides: codex.evaluator_decides,
      default_model: null,
      default_effort: null,
    },
  }),
  'agents.storage': () => ({
    auto_clean: { enabled: STORAGE_SCHEDULE_DEFAULTS.enabled, idle_days: STORAGE_SCHEDULE_DEFAULTS.idle_days },
  }),
  'agents.channels': () => ({ channels: {}, poller_access: {}, thread_replies: {} }),
  'capabilities.mcp_servers': (current) => {
    const borrowed = isBorrowed(localServers(readHostConfig()), null)
    return { defaults: each(current.defaults, (name) => !borrowed(name)) }
  },
  'capabilities.plugins': () => ({ folders: {} }),
  'security.sign_in': () => ({ require_passkey: false, passkeys: [], devices: [] }),
  'security.sandbox': () => ({
    enabled: SANDBOX_POLICY_DEFAULT.enabled,
    allowed_domains: [...SANDBOX_POLICY_DEFAULT.allowed_domains],
    hidden_paths: [...SANDBOX_POLICY_DEFAULT.hidden_paths],
  }),
  'security.permissions': () => ({
    request_timeout_minutes: DEFAULT_PERMISSION_TIMEOUT_MINUTES,
    rules: { allow: [], ask: [], deny: [], review: [] },
  }),
  'security.connections': () => ({ connections: {} }),
  'security.credentials': async (current) => ({
    credentials: await defaultCredential(),
    agent_tokens: each(current.agent_tokens, () => 'not set' as const),
    default_access: each(current.default_access, () => false),
  }),
  'security.ssh': (current) => ({
    hosts: {},
    keys: [],
    default_access: each(current.default_access, () => false),
  }),
  'security.sharing': () => ({ enabled: false }),
}

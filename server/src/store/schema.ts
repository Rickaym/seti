import type { Db } from '../pg.js'
import { ACCESS_DEFAULTS, CREDENTIAL_PROFILES, MCP_SELECTION } from './schema-access.js'
import { AGENT_GUIDE, SETI_GUIDE_PACK } from './schema-agent-guide.js'
import { ARCHIVE_FILES, REPEAT_GUARD, RESTART_RESUME, TASK_ARCHIVE } from './schema-archive.js'
import { SETI_AUTH } from './schema-auth.js'
import { CHANGE_REQUESTS } from './schema-change-requests.js'
import { CHANGELOG } from './schema-changelog.js'
import { COMPACT_RULES } from './schema-compact.js'
import { CONNECTIONS, secretsToConnections } from './schema-connections.js'
import { recountTaskCosts, TASK_COST_SESSION, TASK_SIDE_CHAT_COST } from './schema-cost.js'
import { CPU_CAPS } from './schema-cpu.js'
import { ANDROID_OVERRIDE, DEVICE_SHOW_NAMES, DEVICES, dropOfficialAndroidRow } from './schema-devices.js'
import {
  ATTENTION_TIERS,
  EA_CONTEXT_PACKS,
  EA_FORM_OF_ADDRESS,
  EA_INBOX,
  EA_INBOX_COALESCE,
  EA_INBOX_URGENT,
  EA_INDEX,
  EA_JOIN_ON_OPEN,
  EA_REPLIES,
  EA_USAGE,
} from './schema-ea.js'
import { INITIAL } from './schema-initial.js'
import { KNOWLEDGE } from './schema-knowledge.js'
import { MEMORY_CAPS } from './schema-memory.js'
import { MODS_RUNTIME } from './schema-mods-runtime.js'
import { BLOBS_ONE_STYLE, MODS, PREVIEWS_MOD, REQUIRED_MODS, USER_THEME } from './schema-mods.js'
import { NOTIFICATIONS } from './schema-notifications.js'
import { CHANNEL_EVENT_ROUTING, CHANNEL_RUN_DUE, POLLER_CHANNELS } from './schema-pollers.js'
import { QUESTION_SECRETS, QUESTIONS } from './schema-questions.js'
import { DROP_ROUTINES, REMINDER_CHANNELS, REMINDER_CRON } from './schema-reminders.js'
import { PACK_KIND, rolesToPacks } from './schema-roles.js'
import { MESSAGE_SEARCH, MESSAGE_SEARCH_TALK, MESSAGE_TIME } from './schema-search.js'
import { CLAUDE_LOGINS, PERMISSIONS, SANDBOX_AWS, SANDBOX_SSH, SECRET_ENV, SECRETS } from './schema-security.js'
import { CLIENT_SENDS } from './schema-sends.js'
import { SHARE_PREVIEWS, SHARES } from './schema-shares.js'
import { loginsToHosts, SSH_HOST_KEYS } from './schema-ssh-keys.js'
import { importSshHosts, SSH_HOSTS } from './schema-ssh.js'
import {
  AGENT_START,
  AGENT_WAITS,
  DROP_THINKING_ESTIMATES,
  OWN_PROMPT_INDEX,
  PERMISSION_MODE_AUTO,
  PR_HELD_INPUT,
  SUBTASK_PR,
  TASK_BYPASS_UNTIL,
  TASK_CLOSING_LINE,
  TASK_COLOR_HEX,
  TASK_DIRS,
  TASK_SETI_CONTROL,
  TASK_SETI_LEVEL,
  TASK_WORKTREE_BACKFILL,
  TRIM_SESSION_INIT,
} from './schema-tasks.js'
import { EA_DOC_NO_DIRECT, TEAM_CHAT, TEAM_DIRECT, TEAM_MESSAGE_SELF_HEADERS } from './schema-team.js'
import { DROP_ESLINTCACHE_DEFAULT, WARM_CACHES } from './schema-warm-caches.js'
import {
  CHANNEL_SECRET_PENDING,
  CHANNEL_SOURCE_MODS,
  CHANNEL_SUBSCRIPTIONS,
  EA_CHANNEL_MODE,
  WEBHOOK_CHANNELS,
} from './schema-webhooks.js'
import { WORKSPACE_GRIDS, WORKSPACES } from './schema-workspaces.js'

/** A schema change; startup applies the pending ones in version order, all in one transaction. */
export interface Migration {
  version: number
  name: string
  sql: string
  /** Moves data SQL alone cannot, after `sql`, in the same transaction. */
  run?: (tx: Db) => Promise<void>
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL },
  { version: 2, name: 'ea_inbox', sql: EA_INBOX },
  { version: 3, name: 'ea_index', sql: EA_INDEX },
  { version: 4, name: 'team_chat', sql: TEAM_CHAT },
  { version: 5, name: 'subtask_pr', sql: SUBTASK_PR },
  { version: 7, name: 'ea_inbox_urgent', sql: EA_INBOX_URGENT },
  { version: 8, name: 'webhook_channels', sql: WEBHOOK_CHANNELS },
  { version: 9, name: 'task_archive', sql: TASK_ARCHIVE },
  { version: 10, name: 'drop_thinking_estimates', sql: DROP_THINKING_ESTIMATES },
  { version: 11, name: 'secrets', sql: SECRETS },
  { version: 12, name: 'sandbox_aws', sql: SANDBOX_AWS },
  { version: 13, name: 'sandbox_ssh', sql: SANDBOX_SSH },
  { version: 14, name: 'channel_secret_pending', sql: CHANNEL_SECRET_PENDING },
  { version: 15, name: 'task_dirs', sql: TASK_DIRS + TASK_WORKTREE_BACKFILL },
  { version: 16, name: 'task_pinned', sql: 'ALTER TABLE task ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;' },
  { version: 17, name: 'ea_join_on_open', sql: EA_JOIN_ON_OPEN },
  { version: 18, name: 'channel_subscriptions', sql: CHANNEL_SUBSCRIPTIONS },
  { version: 19, name: 'poller_channels', sql: POLLER_CHANNELS },
  { version: 20, name: 'mcp_selection', sql: MCP_SELECTION },
  { version: 21, name: 'credential_profiles', sql: CREDENTIAL_PROFILES },
  { version: 22, name: 'agent_guide', sql: AGENT_GUIDE },
  { version: 23, name: 'seti_guide_pack', sql: SETI_GUIDE_PACK },
  { version: 24, name: 'access_defaults', sql: ACCESS_DEFAULTS },
  { version: 25, name: 'agent_start', sql: AGENT_START },
  { version: 26, name: 'ssh_hosts', sql: SSH_HOSTS, run: importSshHosts },
  { version: 27, name: 'warm_caches', sql: WARM_CACHES },
  { version: 28, name: 'drop_eslintcache_default', sql: DROP_ESLINTCACHE_DEFAULT },
  { version: 29, name: 'message_search', sql: MESSAGE_SEARCH },
  { version: 30, name: 'task_role', sql: 'ALTER TABLE task ADD COLUMN role TEXT;' },
  { version: 31, name: 'roles_as_packs', sql: PACK_KIND, run: rolesToPacks },
  { version: 32, name: 'ea_context_packs', sql: EA_CONTEXT_PACKS },
  { version: 33, name: 'memory_caps', sql: MEMORY_CAPS },
  { version: 34, name: 'team_delivery_now', sql: "UPDATE team_delivery SET mode = 'now' WHERE mode = 'interrupt';" },
  { version: 35, name: 'task_seti_control', sql: TASK_SETI_CONTROL },
  { version: 36, name: 'task_color', sql: 'ALTER TABLE task ADD COLUMN color TEXT;' },
  { version: 37, name: 'task_color_hex', sql: TASK_COLOR_HEX },
  { version: 38, name: 'task_cost_session', sql: TASK_COST_SESSION, run: recountTaskCosts },
  { version: 39, name: 'claude_logins', sql: CLAUDE_LOGINS },
  { version: 40, name: 'workspaces', sql: WORKSPACES },
  { version: 41, name: 'notifications', sql: NOTIFICATIONS },
  { version: 42, name: 'task_status_line', sql: 'ALTER TABLE task ADD status_line TEXT, ADD status_line_at TEXT;' },
  { version: 43, name: 'agent_waits', sql: AGENT_WAITS },
  { version: 44, name: 'workspace_grids', sql: WORKSPACE_GRIDS },
  { version: 45, name: 'task_unseen', sql: 'ALTER TABLE task ADD COLUMN unseen BOOLEAN NOT NULL DEFAULT false;' },
  { version: 46, name: 'task_asking', sql: 'ALTER TABLE task ADD COLUMN asking BOOLEAN NOT NULL DEFAULT false;' },
  { version: 47, name: 'team_message_self_headers', sql: TEAM_MESSAGE_SELF_HEADERS },
  { version: 48, name: 'ea_channel_mode', sql: EA_CHANNEL_MODE },
  { version: 51, name: 'permissions', sql: PERMISSIONS },
  { version: 52, name: 'seti_auth', sql: SETI_AUTH },
  { version: 53, name: 'devices', sql: DEVICES },
  { version: 54, name: 'reminder_channels', sql: REMINDER_CHANNELS },
  { version: 55, name: 'android_override', sql: ANDROID_OVERRIDE, run: dropOfficialAndroidRow },
  { version: 56, name: 'permission_mode_auto', sql: PERMISSION_MODE_AUTO },
  { version: 57, name: 'message_search_talk', sql: MESSAGE_SEARCH_TALK },
  { version: 58, name: 'ssh_host_keys', sql: SSH_HOST_KEYS, run: loginsToHosts },
  { version: 59, name: 'archive_files', sql: ARCHIVE_FILES },
  { version: 60, name: 'changelog', sql: CHANGELOG },
  { version: 61, name: 'compact_rules', sql: COMPACT_RULES },
  { version: 62, name: 'secret_env', sql: SECRET_ENV },
  { version: 63, name: 'client_sends', sql: CLIENT_SENDS },
  { version: 64, name: 'channel_run_due', sql: CHANNEL_RUN_DUE },
  { version: 65, name: 'channel_event_routing', sql: CHANNEL_EVENT_ROUTING },
  { version: 66, name: 'task_message_created', sql: MESSAGE_TIME },
  { version: 67, name: 'pr_held_input', sql: PR_HELD_INPUT },
  { version: 68, name: 'shares', sql: SHARES },
  { version: 69, name: 'cpu_caps', sql: CPU_CAPS },
  { version: 70, name: 'share_previews', sql: SHARE_PREVIEWS },
  { version: 71, name: 'task_bypass_until', sql: TASK_BYPASS_UNTIL },
  { version: 72, name: 'device_show_names', sql: DEVICE_SHOW_NAMES },
  { version: 73, name: 'drop_routines', sql: DROP_ROUTINES },
  { version: 74, name: 'reminder_cron', sql: REMINDER_CRON },
  { version: 75, name: 'task_side_chat_cost', sql: TASK_SIDE_CHAT_COST },
  { version: 76, name: 'task_seti_level', sql: TASK_SETI_LEVEL },
  { version: 77, name: 'change_requests', sql: CHANGE_REQUESTS },
  { version: 78, name: 'connections', sql: CONNECTIONS, run: secretsToConnections },
  { version: 79, name: 'task_message_own_prompt', sql: OWN_PROMPT_INDEX },
  { version: 80, name: 'team_direct', sql: TEAM_DIRECT },
  { version: 81, name: 'ea_doc_no_direct', sql: EA_DOC_NO_DIRECT },
  { version: 82, name: 'ea_replies', sql: EA_REPLIES },
  { version: 83, name: 'mods', sql: MODS },
  { version: 84, name: 'user_theme', sql: USER_THEME },
  { version: 85, name: 'channel_source_mods', sql: CHANNEL_SOURCE_MODS },
  { version: 86, name: 'mods_runtime', sql: MODS_RUNTIME },
  { version: 87, name: 'previews_mod', sql: PREVIEWS_MOD },
  { version: 88, name: 'required_mods', sql: REQUIRED_MODS },
  { version: 89, name: 'task_closing_line', sql: TASK_CLOSING_LINE },
  { version: 90, name: 'ea_usage', sql: EA_USAGE },
  { version: 91, name: 'ea_inbox_coalesce', sql: EA_INBOX_COALESCE },
  { version: 92, name: 'attention_tiers', sql: ATTENTION_TIERS },
  { version: 93, name: 'restart_resume', sql: RESTART_RESUME },
  { version: 94, name: 'blobs_one_style', sql: BLOBS_ONE_STYLE },
  { version: 95, name: 'ea_form_of_address', sql: EA_FORM_OF_ADDRESS },
  { version: 96, name: 'trim_session_init', sql: TRIM_SESSION_INIT },
  { version: 97, name: 'repeat_guard', sql: REPEAT_GUARD },
  { version: 98, name: 'knowledge', sql: KNOWLEDGE },
  { version: 99, name: 'questions', sql: QUESTIONS },
  { version: 100, name: 'question_secrets', sql: QUESTION_SECRETS },
]

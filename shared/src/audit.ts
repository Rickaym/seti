import { z } from 'zod'

export const AUDIT_ACTORS = ['user', 'agent', 'system'] as const
export type AuditActor = (typeof AUDIT_ACTORS)[number]

/** Who the audit log filters by: an actor, or `mod` for every `mod:<id>`. */
export const AUDIT_ACTOR_FILTERS = ['user', 'agent', 'mod', 'system'] as const
export type AuditActorFilter = (typeof AUDIT_ACTOR_FILTERS)[number]

export const AUDIT_AREAS = [
  'task',
  'agent',
  'repo',
  'context',
  'mcp',
  'plugin',
  'pr',
  'account',
  'seti',
  'ea',
  'team',
  'workspace',
  'mod',
  'system',
] as const
export type AuditArea = (typeof AUDIT_AREAS)[number]

export const AUDIT_KINDS = [
  'task.created',
  'task.imported',
  'task.renamed',
  'task.message_sent',
  'task.queued_message_removed',
  'task.stopped',
  'task.subtask_stopped',
  'task.process_stopped',
  'task.session_ended',
  'task.session_restarted',
  'task.deleted',
  'task.pr_linked',
  'task.pr_unlinked',
  'task.subtask_pr_linked',
  'task.subtask_pr_unlinked',
  'task.context_packs_changed',
  'task.shell_run',
  'task.shell_stopped',
  'task.terminal_opened',
  'task.terminal_closed',
  'task.rewound',
  'task.side_chat',
  'task.input_mode_changed',
  'task.access_changed',
  'task.pinned_changed',
  'task.color_changed',
  'task.role_changed',
  'task.mcp_changed',
  'task.profile_changed',
  'task.repo_added',
  'task.caches_seeded',
  'task.repo_removed',
  'task.dir_added',
  'task.dir_removed',
  'task.cwd_changed',
  'task.inputs_delivered',
  'task.resumed_after_restart',
  'task.inputs_dismissed',
  'task.wait_added',
  'task.archived',
  'task.files_archived',
  'task.file_saved',
  'task.file_shared',
  'task.share_updated',
  'task.share_link_rotated',
  'task.share_revoked',
  'task.share_link_preview',
  'task.files_attached',
  'task.unarchived',
  'task.memory_cap_changed',
  'task.cpu_cap_changed',
  'task.compact_changed',
  'task.workspace_changed',
  'task.notifications_changed',
  'task.permission_allowed',
  'task.permission_denied',
  'task.permission_rule_added',
  'task.permission_rule_removed',
  'task.bypass_on',
  'task.bypass_off',
  'task.bypass_expired',
  'task.change_requested',
  'task.change_allowed',
  'task.change_denied',
  'task.change_expired',
  'task.host_allowed',
  'task.host_removed',
  'task.api_key_blocked',
  'agent.outward',
  'repo.added',
  'repo.updated',
  'repo.removed',
  'repo.warm_caches_changed',
  'context.file_saved',
  'context.pack_created',
  'context.pack_updated',
  'context.pack_deleted',
  'context.pack_default_changed',
  'mcp.signin_started',
  'mcp.signin_completed',
  'mcp.signin_failed',
  'mcp.signin_cancelled',
  'mcp.server_added',
  'mcp.server_removed',
  'mcp.server_reconnected',
  'mcp.default_changed',
  'mcp.choices_forgotten',
  'mcp.signins_restored',
  'plugin.default_added',
  'plugin.default_enabled',
  'plugin.default_disabled',
  'plugin.default_removed',
  'plugin.installed',
  'plugin.uninstalled',
  'plugin.enabled',
  'plugin.disabled',
  'plugin.updated',
  'plugin.marketplace_added',
  'plugin.marketplace_updated',
  'plugin.marketplace_removed',
  'pr.redeploy_requested',
  'account.health_changed',
  'account.login_saved',
  'account.login_updated',
  'account.login_renamed',
  'account.login_removed',
  'account.switched',
  'seti.context_pack_created',
  'seti.context_pack_updated',
  'seti.context_file_saved',
  'seti.task_context_packs_changed',
  'seti.note_added',
  'ea.history_cleared',
  'ea.chat_message',
  'ea.settings_changed',
  'ea.context_packs_changed',
  'ea.followup_scheduled',
  'ea.followup_cancelled',
  'ea.watch_added',
  'ea.watch_removed',
  'ea.inbox_delivered',
  'ea.ask_allowed',
  'ea.ask_denied',
  'team.message_posted',
  'team.direct_posted',
  'team.message_delivered',
  'team.member_changed',
  'team.file_sent',
  'workspace.created',
  'workspace.renamed',
  'workspace.deleted',
  'mod.enabled',
  'mod.disabled',
  'mod.settings_changed',
  'mod.safe_mode_changed',
  'mod.installed',
  'mod.updated',
  'mod.update_pending',
  'mod.rolled_back',
  'mod.uninstalled',
  'mod.granted',
  'mod.files_changed',
  'mod.paused',
  'mod.turned_off_by_seti',
  'mod.ran',
  'mod.call_refused',
  'mod.api_key_blocked',
  'mod.ask_allowed',
  'mod.ask_denied',
  'mod.bisect_step',
  'mod.dev_mode_changed',
  'mod.action_run',
  'system.started',
  'system.sandbox_changed',
  'system.aws_changed',
  'system.theme_changed',
  'system.access_default_changed',
  'system.profile_created',
  'system.profile_changed',
  'system.profile_deleted',
  'system.ssh_changed',
  'system.ssh_key_added',
  'system.ssh_key_changed',
  'system.ssh_key_removed',
  'system.ssh_host_keys_accepted',
  'system.ssh_host_removed',
  'system.ssh_host_created',
  'system.ssh_host_changed',
  'system.ssh_host_renamed',
  'system.ssh_host_deleted',
  'system.ssh_login_set',
  'system.ssh_login_removed',
  'system.ssh_migrated',
  'system.roles_migrated',
  'system.channel_created',
  'system.channel_changed',
  'system.channel_secret_rotated',
  'system.channel_secret_revealed',
  'system.channel_deleted',
  'system.channel_subscribed',
  'system.channel_unsubscribed',
  'system.channel_filter_changed',
  'system.channel_mode_changed',
  'system.channel_polled',
  'system.backup_created',
  'system.backup_failed',
  'system.auto_archive_changed',
  'system.stale_folders_deleted',
  'system.memory_cap_changed',
  'system.cpu_cap_changed',
  'system.compact_changed',
  'system.terminal_opened',
  'system.terminal_closed',
  'system.notifications_changed',
  'system.permission_rule_added',
  'system.permission_rule_removed',
  'system.secret_set',
  'system.secret_cleared',
  'system.secret_linked',
  'system.connection_created',
  'system.connection_changed',
  'system.connection_deleted',
  'system.connections_migrated',
  'system.secret_imported',
  'system.local_signin',
  'system.signin',
  'system.stepped_up',
  'system.signin_failed',
  'system.signout',
  'system.passkey_added',
  'system.passkey_renamed',
  'system.passkey_removed',
  'system.session_revoked',
  'system.auth_enforcement_changed',
  'system.setup_code_created',
  'system.pairing_code_created',
  'system.device_paired',
  'system.device_renamed',
  'system.device_widget_changed',
  'system.device_revoked',
  'system.android_app_changed',
  'system.device_pair_failed',
  'system.device_proof_refused',
  'system.sharing_changed',
  'system.shares_revoked',
] as const satisfies readonly `${AuditArea}.${string}`[]
export type AuditKind = (typeof AUDIT_KINDS)[number]

export const AUDIT_SUBJECT_TYPES = [
  'task',
  'repo',
  'context_file',
  'context_pack',
  'mcp_server',
  'plugin',
  'credential_profile',
  'connection',
  'pr',
  'account',
  'ea',
  'team',
  'workspace',
  'mod',
  'system',
] as const
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number]

export type AuditDetailValue = string | number | boolean | null | string[]
export type AuditDetail = Record<string, AuditDetailValue>

/** Values only past events carry: routines recorded them before Seti removed routines. */
type RetiredKind = `routine.${string}` | 'seti.routine_updated'

/**
 * A kind a mod declared, recorded as `mod.<id>.<kind>`. Seti records only kinds an enabled mod
 * declares; past events keep theirs after the mod is gone, as retired kinds do.
 */
export type ModAuditKind = `mod.${string}.${string}`

/** What a mod did through the mod API is recorded as `mod:<id>`. */
export type ModActor = `mod:${string}`

export const modAuditKind = (mod: string, kind: string): ModAuditKind => `mod.${mod}.${kind}`

export const modActor = (mod: string): ModActor => `mod:${mod}`

export interface AuditEvent {
  id: number
  at: string
  actor: AuditActor | 'routine' | ModActor
  kind: AuditKind | ModAuditKind | RetiredKind
  subject_type: AuditSubjectType | 'routine'
  subject_id: string | null
  summary: string
  detail: AuditDetail
}

export interface AuditPage {
  events: AuditEvent[]
  /** Pass as `before` to load the next older page; null when there is none. */
  next_before: number | null
}

export const AUDIT_PAGE_MAX = 200

/** Whether every stored event still links to the one before it and matches its hash. */
export interface AuditChainStatus {
  ok: boolean
  /** Events whose link and hash were checked. */
  checked: number
  /** The newest event the chain recorded, and its hash, as written to the journal each day. */
  head_id: number
  head_hash: string
  /** The first event that failed, or null when the chain is intact. */
  broken_at: number | null
  problem: string | null
}

export interface AuditStatus {
  retention_days: number
  chain: AuditChainStatus
}

export const auditArea = (kind: AuditKind | ModAuditKind): AuditArea => kind.slice(0, kind.indexOf('.')) as AuditArea

/** `kind` takes an area such as `task`, a kind such as `task.created`, or `mod.<id>.<kind>`. */
export const auditQuery = z.object({
  kind: z
    .union([z.enum([...AUDIT_AREAS, ...AUDIT_KINDS]), z.string().regex(/^mod\.[a-z0-9-]+\.[a-z0-9_-]+$/)])
    .optional(),
  actor: z.enum(AUDIT_ACTOR_FILTERS).optional(),
  q: z.string().trim().max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
})
export type AuditQuery = z.output<typeof auditQuery>

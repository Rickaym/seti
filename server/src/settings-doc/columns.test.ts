import { describe, expect, it } from 'vitest'
import { sql } from '../db.js'
import { withBundledMods } from '../test-mods.js'
import { settingsDocJsonSchema } from './document.js'

withBundledMods()

/** A column that holds state, not a setting, with the reason it stays out of the document. */
const state = (reason: string) => ({ state: reason })

/**
 * Where each column of a settings table appears in the settings document. A migration that adds a
 * column fails this test until the column is given a path here, or a reason it is state.
 */
const COLUMNS: Record<string, string | { state: string }> = {
  'user_settings.name': 'app.general.name',
  'user_settings.theme': 'app.general.theme',
  'notification_settings.tiers': 'app.notifications.tiers',
  'notification_settings.finished': state('derived from the tiers for an older release'),
  'notification_settings.needs_you': state('derived from the tiers for an older release'),
  'notification_settings.ea_replies': state('derived from the tiers for an older release'),
  'ea_settings.wake_enabled': 'app.ea.wake_enabled',
  'ea_settings.wake_phrase': 'app.ea.wake_phrase',
  'ea_settings.keep_awake_seconds': 'app.ea.keep_awake_seconds',
  'ea_settings.join_on_open': 'app.ea.join_on_open',
  'ea_settings.form_of_address': 'app.ea.form_of_address',
  'ea_settings.language': 'app.ea.language',
  'ea_settings.inbox_relays': state('a security switch only the user changes, on the EA page'),
  'archive_settings.auto_enabled': 'agents.lifecycle.auto_archive.enabled',
  'archive_settings.auto_days': 'agents.lifecycle.auto_archive.days',
  'archive_settings.delete_after_days': 'agents.lifecycle.auto_archive.delete_after_days',
  'archive_settings.resume_after_restart': 'agents.lifecycle.auto_archive.resume_after_restart',
  'archive_settings.repeat_guard': 'agents.lifecycle.auto_archive.repeat_guard',
  'compact_settings.auto': 'agents.lifecycle.compaction.auto',
  'compact_settings.window_k': 'agents.lifecycle.compaction.window_k',
  'compact_settings.threshold_pct': 'agents.lifecycle.compaction.threshold_pct',
  'compact_settings.instructions': 'agents.lifecycle.compaction.instructions',
  'dream_settings.enabled': 'agents.lifecycle.dreaming.enabled',
  'dream_settings.window_start': 'agents.lifecycle.dreaming.window_start',
  'dream_settings.window_end': 'agents.lifecycle.dreaming.window_end',
  'dream_settings.zone': 'agents.lifecycle.dreaming.zone',
  'dream_settings.model': 'agents.lifecycle.dreaming.model',
  'dream_settings.dream_budget_usd': 'agents.lifecycle.dreaming.dream_budget_usd',
  'dream_settings.night_budget_usd': 'agents.lifecycle.dreaming.night_budget_usd',
  'dream_settings.at_once': 'agents.lifecycle.dreaming.at_once',
  'dream_settings.cleanups': 'agents.lifecycle.dreaming.cleanups',
  'memory_settings.high_mb': 'agents.resources.memory_cap.high_mb',
  'memory_settings.max_mb': 'agents.resources.memory_cap.max_mb',
  'memory_settings.swap_max_mb': 'agents.resources.memory_cap.swap_max_mb',
  'cpu_settings.quota_percent': 'agents.resources.cpu_cap.quota_percent',
  'codex_settings.enabled': 'agents.runtimes.codex.enabled',
  'codex_settings.program': 'agents.runtimes.codex.program',
  'codex_settings.evaluator_decides': 'agents.runtimes.codex.evaluator_decides',
  'codex_settings.default_model': 'agents.runtimes.codex.default_model',
  'codex_settings.default_effort': 'agents.runtimes.codex.default_effort',
  'storage_settings.auto_clean': 'agents.storage.auto_clean.enabled',
  'storage_settings.idle_days': 'agents.storage.auto_clean.idle_days',
  'storage_settings.last_run_at': state('when the clean last ran'),
  'storage_settings.last_freed_bytes': state('what the clean last freed'),
  'permission_settings.request_timeout_minutes': 'security.permissions.request_timeout_minutes',
  'sandbox_policy.enabled': 'security.sandbox.enabled',
  'sandbox_policy.allowed_domains': 'security.sandbox.allowed_domains',
  'sandbox_policy.hidden_paths': 'security.sandbox.hidden_paths',
  'share_settings.enabled': 'security.sharing.enabled',
  'auth_settings.enforced': 'security.sign_in.require_passkey',
  'auth_settings.user_handle': state('the WebAuthn user handle, made once'),
  'mcp_server_default.name': 'capabilities.mcp_servers.defaults',
  'mcp_server_default.enabled': 'capabilities.mcp_servers.defaults',
  'access_default.kind': 'security.ssh.default_access',
  'access_default.item': 'security.ssh.default_access',
  'access_default.enabled': 'security.credentials.default_access',
  'mod_settings.mod_id': 'mods',
  'mod_settings.key': 'mods',
  'mod_settings.value': 'mods',
}

/** Settings tables no release reads any more, kept for a rollback until a migration drops them. */
const RETIRED = ['ssh_settings']

interface Schema {
  properties?: Record<string, Schema>
}

const has = (schema: Schema, path: string) =>
  path.split('.').reduce<Schema | undefined>((at, key) => at?.properties?.[key], schema) !== undefined

describe('settings tables and the settings document', () => {
  it('give every column of every settings table a path or a reason', async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = current_schema()
        AND (table_name LIKE '%\\_settings' OR table_name IN ('sandbox_policy', 'mcp_server_default', 'access_default'))
        AND column_name NOT IN ('id', 'updated_at')`
    const live = rows
      .filter((row) => !RETIRED.includes(row.table_name))
      .map((row) => `${row.table_name}.${row.column_name}`)
    expect(
      live.filter((column) => !(column in COLUMNS)),
      'columns with no path: add them to COLUMNS',
    ).toEqual([])
    expect(
      Object.keys(COLUMNS).filter((column) => !live.includes(column)),
      'paths of columns that are gone',
    ).toEqual([])
    const schema = (await settingsDocJsonSchema()) as Schema
    const paths = Object.values(COLUMNS).filter((path): path is string => typeof path === 'string')
    expect(
      paths.filter((path) => !has(schema, path)),
      'paths missing from the document',
    ).toEqual([])
  })
})

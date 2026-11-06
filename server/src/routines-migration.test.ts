import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const ROUTINE_TABLES = [
  'routine',
  'routine_run',
  'routine_context_pack',
  'routine_repo',
  'routine_plugin_optout',
  'routine_mcp_server',
]

const ROUTINES = `
INSERT INTO routine (id, name, schedule, timezone, prompt, created_at, updated_at)
  VALUES ('nightly', 'Nightly', '0 3 * * *', 'UTC', 'Check', 'x', 'x');
INSERT INTO revision (at, actor, object_type, object_id, before, after, reason) VALUES
  ('x', 'user', 'routine', 'nightly', NULL, '{}', NULL),
  ('x', 'user', 'context_pack', 'ops', NULL, '{}', NULL);
INSERT INTO revision_seen (object_type, object_id, revision_id) VALUES ('routine', 'nightly', 1), ('context_pack', 'ops', 2);`

const REMINDER = `
INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at, source)
  VALUES ('standup', 'Standup', 'reminder', NULL, '{}', 'x', 'x', 'reminder');
INSERT INTO channel_reminder (channel_id, script, interval_s, enabled, next_run_at)
  VALUES ('standup', 'export default () => null', 600, true, NULL);`

describe('the routine migrations', () => {
  it('drop the routine tables and their revisions, and keep other revisions', async () => {
    const outcome = await migrateWith('drop_routines', ROUTINES, async (tx) => {
      const tables = await tx<{ found: string | null }[]>`SELECT to_regclass(name)::text AS found
        FROM unnest(${ROUTINE_TABLES}::text[]) AS name`
      const kept = await tx<{ object_type: string }[]>`SELECT object_type FROM revision ORDER BY id`
      const seen = await tx<{ object_type: string }[]>`SELECT object_type FROM revision_seen ORDER BY object_type`
      return {
        tables: tables.map((row) => row.found),
        revisions: kept.map((row) => row.object_type),
        seen: seen.map((row) => row.object_type),
      }
    })
    expect(outcome).toEqual({
      tables: ROUTINE_TABLES.map(() => null),
      revisions: ['context_pack'],
      seen: ['context_pack'],
    })
  })

  it('leave existing reminders on their interval', async () => {
    const rows = await migrateWith('reminder_cron', REMINDER, async (tx) => [
      ...(await tx`SELECT channel_id, interval_s, cron, timezone FROM channel_reminder`),
    ])
    expect(rows).toEqual([{ channel_id: 'standup', interval_s: 600, cron: null, timezone: null }])
  })
})

import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const AT = '2026-10-01T00:00:00.000Z'

const SEED = `
  INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('agent', 'Agent', '/tmp', 'idle', '${AT}', 'x');
  INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at)
    VALUES ('slack', 'Slack', 'generic', 'plain', '{}', '${AT}', '${AT}');
  INSERT INTO channel_subscription (channel_id, target, task_id, events, created_at) VALUES
    ('slack', 'ea', NULL, NULL, '${AT}'),
    ('slack', 'task', 'agent', NULL, '${AT}');
  INSERT INTO ea_inbox (kind, event, title, body, severity, source, due_at, created_at)
    VALUES ('channel_event', 'event', 'ask', '', 'info', 'Slack', '${AT}', '${AT}');`

describe('ea_channel_mode migration', () => {
  it('leaves every subscription reporting and lets only the EA act', async () => {
    const outcome = await migrateWith('ea_channel_mode', SEED, async (tx) => {
      const modes = await tx<{ target: string; mode: string }[]>`SELECT target, mode FROM channel_subscription
        ORDER BY id`
      const acts = await tx<{ act: boolean }[]>`SELECT act FROM ea_inbox`
      await tx`UPDATE channel_subscription SET mode = 'act' WHERE target = 'ea'`
      await tx`SAVEPOINT task_act`
      const refused = await tx`UPDATE channel_subscription SET mode = 'act' WHERE target = 'task'`.then(
        () => '',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      await tx`ROLLBACK TO SAVEPOINT task_act`
      return { modes, acts, refused }
    })
    expect(outcome.modes).toEqual([
      { target: 'ea', mode: 'report' },
      { target: 'task', mode: 'report' },
    ])
    expect(outcome.acts).toEqual([{ act: false }])
    expect(outcome.refused).toMatch(/channel_subscription_task_reports/)
  })
})

import { describe, expect, it } from 'vitest'
import { now, sql } from './db.js'

const HASH = 'b'.repeat(64)
let installs = 0

async function insertInstall(extra: { pending_hash?: string; pending_reason?: string; pending_since?: string }) {
  const at = now()
  installs += 1
  await sql`INSERT INTO mod_install (mod_id, source_kind, source, current_hash, pending_hash, pending_reason,
      pending_since, installed_at, updated_at)
    VALUES (${`mod-${String(installs)}`}, 'git', 'https://git.example.com/m.git', ${HASH},
      ${extra.pending_hash ?? null}, ${extra.pending_reason ?? null}, ${extra.pending_since ?? null}, ${at}, ${at})`
}

describe('the mods_runtime migration', () => {
  it('keeps an install pinned, with a whole pending update or none, and a 24 h default delay', async () => {
    await insertInstall({})
    const [row] = await sql<{ update_delay_hours: number }[]>`SELECT update_delay_hours FROM mod_install LIMIT 1`
    expect(row?.update_delay_hours).toBe(24)
    await insertInstall({ pending_hash: HASH, pending_reason: 'consent', pending_since: now() })
    await expect(insertInstall({ pending_hash: HASH })).rejects.toThrow(/check constraint/)
    await expect(insertInstall({ pending_hash: HASH, pending_reason: 'soon', pending_since: now() })).rejects.toThrow(
      /check constraint/,
    )
    await expect(sql`UPDATE mod_install SET update_delay_hours = 169 WHERE pending_hash IS NULL`).rejects.toThrow(
      /check constraint/,
    )
  })

  it('stores versions only under a full hash', async () => {
    const insert = async (hash: string) =>
      sql`INSERT INTO mod_version (mod_id, hash, version, manifest, files, size, fetched_at)
        VALUES ('linear', ${hash}, '1.0.0', ${sql.json({ id: 'linear' })}, ${Buffer.from('{}')}, 2, ${now()})`
    await insert(HASH)
    await expect(insert('ABC')).rejects.toThrow(/check constraint/)
  })

  it('unbinds a grant when its connection is deleted, so the op finds it gone', async () => {
    const at = now()
    await sql`INSERT INTO connection (id, name, kind, env, placeholder, hosts, header, created_at, updated_at)
      VALUES ('c-linear', 'Linear', 'key', 'LINEAR_API_KEY', 'seti-ph-linear', ${['api.linear.app']},
        'Authorization', ${at}, ${at})`
    await sql`INSERT INTO mod_grant (mod_id, hash, idx, capability, connection_id, granted_at)
      VALUES ('linear', ${HASH}, 0, ${sql.json({ name: 'connection' })}, 'c-linear', ${at})`
    await sql`DELETE FROM connection WHERE id = 'c-linear'`
    const [grant] = await sql<{ connection_id: string | null }[]>`SELECT connection_id FROM mod_grant
      WHERE mod_id = 'linear'`
    expect(grant).toEqual({ connection_id: null })
  })

  it('adds the log, asks, usage, bisect, Developer mode, step-up and mod authors', async () => {
    const at = now()
    await sql`INSERT INTO mod_log (mod_id, at, kind, level, line) VALUES ('linear', ${at}, 'refused', 'warn', 'x')`
    await expect(
      sql`INSERT INTO mod_log (mod_id, at, kind, level, line) VALUES ('linear', ${at}, 'audit', 'info', 'x')`,
    ).rejects.toThrow(/check constraint/)
    await sql`INSERT INTO mod_ask (id, mod_id, op, args, summary, created_at, expires_at)
      VALUES ('a1', 'linear', 'tasks.manage.start', ${sql.json({ title: 'x' })}, 'Linear wants to start', ${at}, ${at})`
    await expect(sql`UPDATE mod_ask SET decision = 'maybe' WHERE id = 'a1'`).rejects.toThrow(/check constraint/)
    await sql`INSERT INTO mod_usage (mod_id, day) VALUES ('linear', '2026-11-04')`
    await sql`INSERT INTO mod_bisect (id, original, suspects, step, started_at)
      VALUES (1, ${sql.json({})}, ${sql.json([])}, 0, ${at})`
    await expect(
      sql`INSERT INTO mod_bisect (id, original, suspects, step, started_at)
        VALUES (2, ${sql.json({})}, ${sql.json([])}, 0, ${at})`,
    ).rejects.toThrow(/check constraint/)
    const columns = await sql<{ table_name: string; column_name: string; column_default: string | null }[]>`
      SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE (table_name, column_name) IN (('mod_host', 'dev_mode'), ('auth_session', 'stepped_up_at'),
        ('team_message', 'author_mod_id'))
      ORDER BY table_name`
    expect(columns).toEqual([
      { table_name: 'auth_session', column_name: 'stepped_up_at', column_default: null },
      { table_name: 'mod_host', column_name: 'dev_mode', column_default: 'false' },
      { table_name: 'team_message', column_name: 'author_mod_id', column_default: null },
    ])
  })
})

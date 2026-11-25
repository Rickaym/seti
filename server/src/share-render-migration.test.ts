import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const share = (id: string, name: string, live: boolean) =>
  `INSERT INTO share (id, token_hash, task_id, root, path, real_path, name, kind, mime, created_at, updated_at,
      expires_at, version, scan_override, live)
    VALUES ('${id}', 'hash-${id}', 'task', 'cwd', '${name}', '/tmp/${name}', '${name}', 'text', 'text/plain', 'x', 'x',
      'z', 1, false, ${String(live)});`

const SEED = [
  `INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('task', 'task', '/tmp', 'idle', 'x', 'x');`,
  share('page', 'report.html', false),
  share('upper', 'INDEX.HTM', false),
  share('already', 'live.html', true),
  share('notes', 'notes.md', false),
  share('named', 'page.html.txt', false),
  share('dotless', 'html', false),
].join('\n')

describe('the share render migration', () => {
  it('renders every existing HTML share and no other', async () => {
    const rows = await migrateWith(
      'share_render',
      SEED,
      async (tx) => tx<{ id: string; render: boolean }[]>`SELECT id, render FROM share ORDER BY id`,
    )
    expect(Object.fromEntries(rows.map((row) => [row.id, row.render]))).toEqual({
      already: true,
      dotless: false,
      named: false,
      notes: false,
      page: true,
      upper: true,
    })
  })
})

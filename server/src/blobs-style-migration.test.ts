import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const SEED = `
  INSERT INTO mod_settings (mod_id, key, value, updated_at) VALUES
    ('blobs', 'style', '"Ghost"', 'x'),
    ('blobs', 'size', '"Large"', 'x'),
    ('weather', 'style', '"Bold"', 'x');`

describe('the blobs one style migration', () => {
  it('drops only the blob style a user picked and keeps every other setting', async () => {
    const rows = await migrateWith(
      'blobs_one_style',
      SEED,
      async (tx) => tx<{ mod_id: string; key: string }[]>`SELECT mod_id, key FROM mod_settings ORDER BY mod_id, key`,
    )
    expect([...rows]).toEqual([
      { mod_id: 'blobs', key: 'size' },
      { mod_id: 'weather', key: 'style' },
    ])
  })
})

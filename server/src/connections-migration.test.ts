import { describe, expect, it } from 'vitest'
import { planConnections, type OldState } from './store/connection-plan.js'
import { migrateWith } from './test-migration.js'

const HOLDER = `seti-secret-elevenlabs_api_key-${'ab'.repeat(16)}`
const AT = '2026-10-01T00:00:00.000Z'

const SEED = `
INSERT INTO credential_profile (id, name, aws_region, aws_session_minutes, created_at, updated_at)
  VALUES ('work', 'Work', 'us-east-1', 60, '${AT}', '${AT}');
INSERT INTO secret (name, sealed, source, created_at, updated_at, env, hosts, placeholder) VALUES
  ('named:elevenlabs_api_key', 'sealed-1', 'settings', '${AT}', '${AT}', 'ELEVENLABS_API_KEY',
    '{api.elevenlabs.io}', '${HOLDER}'),
  ('named:vendor_key', 'sealed-2', 'settings', '${AT}', '${AT}', NULL, NULL, NULL),
  ('named:entra_secret', 'sealed-3', 'settings', '${AT}', '${AT}', NULL, NULL, NULL),
  ('named:orphan', 'sealed-4', 'settings', '${AT}', '${AT}', NULL, NULL, NULL),
  ('named:path', 'sealed-5', 'settings', '${AT}', '${AT}', NULL, NULL, NULL),
  ('named:vendor_key_2', 'sealed-6', 'settings', '${AT}', '${AT}', NULL, NULL, NULL);
INSERT INTO credential_profile_secret (profile_id, secret) VALUES
  ('default', 'named:elevenlabs_api_key'), ('work', 'named:elevenlabs_api_key');
INSERT INTO credential_rule (id, profile_id, position, kind, hosts, header, template, secret, minter) VALUES
  ('r1', 'default', 0, 'static', '{api.vendor.test}', 'X-Api-Key', '{{secret}}', 'vendor_key', NULL),
  ('r2', 'work', 0, 'static', '{api.vendor.test}', 'X-Api-Key', '{{secret}}', 'vendor_key', NULL),
  ('r3', 'work', 1, 'static', '{eu.vendor.test}', 'X-Api-Key', '{{secret}}', 'vendor_key', NULL),
  ('r4', 'work', 2, 'minted', '{graph.microsoft.com}', 'Authorization', 'Bearer {{token}}', NULL,
    '{"grant": "client_credentials", "token_url": "https://login.example.test/t/token", "client_id": "app",
      "client_auth": "client_secret_post", "client_secret": "entra_secret", "scope": "s", "extra_params": {}}');
INSERT INTO channel (id, name, preset, created_at, updated_at, source)
  VALUES ('c1', 'Feed', 'blank', '${AT}', '${AT}', 'poller');
INSERT INTO channel_poller (channel_id, script, preset, interval_s, timeout_s, secrets)
  VALUES ('c1', 'export default () => []', 'blank', 300, 30, '["entra_secret", "github_agent_token"]');
`

interface Row {
  name: string
  kind: string
  env: string
  placeholder: string
  hosts: string[]
  header: string | null
  template: string | null
  slots: string | null
  profiles: string | null
}

describe('the connections migration', () => {
  it('maps keys, rules and named secrets onto connections without merging hosts or reading values', async () => {
    const { rows, sealed, audit } = await migrateWith('connections', SEED, async (tx) => ({
      rows: await tx<Row[]>`SELECT c.name, c.kind, c.env, c.placeholder, c.hosts, c.header, c.template,
          (SELECT string_agg(s.slot || '=' || s.secret, ',' ORDER BY s.slot) FROM connection_secret s
            WHERE s.connection_id = c.id) AS slots,
          (SELECT string_agg(p.profile_id, ',' ORDER BY p.profile_id) FROM credential_profile_connection p
            WHERE p.connection_id = c.id) AS profiles
        FROM connection c ORDER BY c.name`,
      sealed: await tx<{ name: string; sealed: string }[]>`SELECT name, sealed FROM secret ORDER BY name`,
      audit: await tx<{ summary: string }[]>`SELECT summary FROM audit_event
        WHERE kind = 'system.connections_migrated'`,
    }))
    const byName = new Map(rows.map((row) => [row.name, row]))
    expect([...byName.keys()]).toEqual([
      'elevenlabs_api_key',
      'entra_secret',
      'graph_microsoft_com',
      'orphan',
      'path',
      'vendor_key',
      'vendor_key_2',
      'vendor_key_3',
    ])
    expect(byName.get('elevenlabs_api_key')).toMatchObject({
      env: 'ELEVENLABS_API_KEY',
      placeholder: HOLDER,
      hosts: ['api.elevenlabs.io'],
      header: null,
      slots: 'value=named:elevenlabs_api_key',
      profiles: 'default,work',
    })
    expect(byName.get('vendor_key')).toMatchObject({
      hosts: ['api.vendor.test'],
      header: 'X-Api-Key',
      template: '{{value}}',
      slots: 'value=named:vendor_key',
      profiles: 'default,work',
    })
    expect(byName.get('vendor_key_3')).toMatchObject({
      env: 'VENDOR_KEY_3',
      hosts: ['eu.vendor.test'],
      slots: 'value=named:vendor_key',
      profiles: 'work',
    })
    expect(byName.get('graph_microsoft_com')).toMatchObject({
      kind: 'client_credentials',
      template: 'Bearer {{value}}',
      slots: 'client_secret=named:entra_secret',
      profiles: 'work',
    })
    expect(byName.get('entra_secret')).toMatchObject({ hosts: [], profiles: null })
    expect(byName.get('path')).toMatchObject({ env: 'KEY_PATH', hosts: [] })
    expect(byName.get('vendor_key_2')).toMatchObject({ slots: 'value=named:vendor_key_2', profiles: null })
    expect(sealed.map((row) => row.sealed)).toEqual([
      'sealed-1',
      'sealed-3',
      'sealed-4',
      'sealed-5',
      'sealed-2',
      'sealed-6',
    ])
    expect(audit[0]?.summary).toBe('Moved 8 API keys, header rules and named secrets onto connections')
  })
})

describe('the connection plan', () => {
  const placeholder = (name: string) => `holder-${name}`

  it('gives a rule on other hosts its own connection under a name no secret has', () => {
    const old: OldState = {
      secrets: [
        { name: 'vendor_key', env: null, hosts: null, placeholder: null },
        { name: 'vendor_key_2', env: null, hosts: null, placeholder: null },
      ],
      grants: [],
      rules: [
        {
          profile_id: 'a',
          kind: 'static',
          hosts: ['one.test'],
          header: 'X',
          template: '{{secret}}',
          secret: 'vendor_key',
          minter: null,
          mint_error: null,
          mint_checked_at: null,
        },
        {
          profile_id: 'b',
          kind: 'static',
          hosts: ['two.test'],
          header: 'X',
          template: '{{secret}}',
          secret: 'vendor_key',
          minter: null,
          mint_error: null,
          mint_checked_at: null,
        },
      ],
      pollerRefs: [],
    }
    const planned = planConnections(old, placeholder)
    expect(planned.map((entry) => [entry.name, entry.env, entry.hosts, entry.profiles])).toEqual([
      ['vendor_key', 'VENDOR_KEY', ['one.test'], ['a']],
      ['vendor_key_3', 'VENDOR_KEY_3', ['two.test'], ['b']],
      ['vendor_key_2', 'VENDOR_KEY_2', [], []],
    ])
  })
})

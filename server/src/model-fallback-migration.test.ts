import { describe, expect, it } from 'vitest'
import { migrateWith } from './test-migration.js'

const init = (model: string) =>
  JSON.stringify({ type: 'system', subtype: 'init', model, permissionMode: 'default', session_id: 's' })

const FALLBACK = JSON.stringify({
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-opus-4-8',
  request_id: 'req_guy',
  api_refusal_category: 'cyber',
  api_refusal_explanation: 'Cyber safeguards flagged this message.',
  content: 'flagged',
  uuid: 'u1',
  session_id: 's',
})

const LOCAL = FALLBACK.replace('"scope":"session"', '"scope":"local"')

const task = (id: string, model: string) =>
  `INSERT INTO task (id, title, cwd, status, created_at, updated_at, model)
    VALUES ('${id}', '${id}', '/tmp', 'idle', 'x', 'x', '${model}');`

const rows = (id: string, payloads: readonly string[]) =>
  payloads
    .map(
      (payload, n) => `INSERT INTO task_message (task_id, kind, payload, created_at)
        VALUES ('${id}', 'sdk', '${payload}', '2026-11-12T10:0${String(n)}:00.000Z');`,
    )
    .join('\n')

const SEED = [
  task('still', 'claude-opus-4-8'),
  rows('still', [init('claude-opus-5-5'), FALLBACK, init('claude-opus-4-8')]),
  task('back', 'claude-opus-5-5'),
  rows('back', [init('claude-opus-5-5'), FALLBACK, init('claude-opus-4-8'), init('claude-opus-5-5')]),
  task('last-turn', 'claude-opus-5-5'),
  rows('last-turn', [init('claude-opus-5-5'), FALLBACK]),
  task('wide', 'claude-opus-4-8[1m]'),
  rows('wide', [FALLBACK, init('claude-opus-4-8[1m]')]),
  task('subagent', 'claude-opus-5-5'),
  rows('subagent', [init('claude-opus-5-5'), LOCAL]),
  task('plain', 'claude-opus-5-5'),
  rows('plain', [init('claude-opus-5-5')]),
].join('\n')

describe('the task model fallback migration', () => {
  it('marks agents still on their fallback model from the notice, and no others', async () => {
    const marked = await migrateWith(
      'task_model_fallback',
      SEED,
      async (tx) =>
        tx<{ id: string; model_fallback: string | null }[]>`SELECT id, model_fallback FROM task ORDER BY id`,
    )
    const byId = new Map(marked.map((row) => [row.id, row.model_fallback]))
    expect(JSON.parse(byId.get('still') ?? 'null')).toEqual({
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-opus-4-8',
      category: 'cyber',
      request_id: 'req_guy',
      at: '2026-11-12T10:01:00.000Z',
    })
    expect(byId.get('back')).toBeNull()
    expect(byId.get('last-turn')).not.toBeNull()
    expect(byId.get('wide')).not.toBeNull()
    expect(byId.get('subagent')).toBeNull()
    expect(byId.get('plain')).toBeNull()
  })
})

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { storedForm } from './session-start.js'
import { migrateWith } from './test-migration.js'

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-test',
  cwd: '/work',
  permissionMode: 'default',
  mcp_servers: [{ name: 'seti', status: 'connected' }],
  plugins: [{ name: 'lint', path: '/plugins/lint' }],
  tools: ['Bash', 'Read'],
  slash_commands: ['compact'],
  skills: ['review'],
} as unknown as SDKMessage

describe('storedForm', () => {
  it('keeps what a session start shows and drops its tool, command and skill lists', () => {
    expect(storedForm(init)).toEqual({ ...init, tools: [], slash_commands: [], skills: [] })
  })

  it('stores every other message as it came', () => {
    const result = { type: 'result', subtype: 'success', result: 'done' } as unknown as SDKMessage
    expect(storedForm(result)).toBe(result)
  })
})

describe('the trim_session_init migration', () => {
  it('trims stored session starts and leaves other rows alone', async () => {
    const at = '2026-11-08T00:00:00.000Z'
    const other = JSON.stringify({ type: 'assistant', tools: ['kept'] })
    const seed = `
      INSERT INTO task (id, title, cwd, status, input_mode, created_at, updated_at)
        VALUES ('t1', 'Agent', '/work', 'idle', 'chat', '${at}', '${at}');
      INSERT INTO task_message (task_id, kind, payload, created_at) VALUES
        ('t1', 'sdk', '${JSON.stringify(init)}', '${at}'),
        ('t1', 'sdk', '${other}', '${at}');
    `
    const rows = await migrateWith(
      'trim_session_init',
      seed,
      async (tx) => tx<{ payload: string }[]>`SELECT payload FROM task_message ORDER BY id`,
    )
    const [trimmed, kept] = rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    expect(trimmed).toEqual({ ...init, tools: [], slash_commands: [], skills: [] })
    expect(kept).toEqual({ type: 'assistant', tools: ['kept'] })
  })
})

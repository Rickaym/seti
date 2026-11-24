import type { CodexMessage, MessageBody, MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import recorded from '../runtimes/codex/reference-turn.json' with { type: 'json' }
import { buildBrief, type BriefSource } from './brief.js'

const SESSION = '5f0c3a52-9d7e-4d3a-8f5e-2b8f3c1e7a10'
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`
let nextId = 1

function row(body: unknown): MessageRow {
  return {
    ...(body as MessageBody),
    id: nextId++,
    task_id: 'task',
    outward: [],
    created_at: '2026-11-24T10:00:00.000Z',
  }
}

const prompt = (text: string, extra: Record<string, unknown> = {}) =>
  row({ kind: 'prompt', payload: { text, ...extra } })

const sdk = (payload: Record<string, unknown>) =>
  row({ kind: 'sdk', payload: { session_id: SESSION, uuid: `u-${String(nextId)}`, ...payload } })

const assistant = (content: unknown[]) =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: `msg_${String(nextId)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-1',
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  })

const call = (id: string, name: string, input: Record<string, unknown>) =>
  assistant([{ type: 'tool_use', id, name, input }])

const ended = (id: string, content: string) =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    tool_use_result: { stdout: content, stderr: '', interrupted: false },
  })

const say = (text: string) => assistant([{ type: 'text', text }])

function claudeRows(): MessageRow[] {
  return [
    prompt(`Fix the login redirect; the token is ${TOKEN}`),
    call('t1', 'TodoWrite', {
      todos: [
        { content: 'Find the redirect', status: 'completed', activeForm: 'Finding' },
        { content: 'Open a PR', status: 'in_progress', activeForm: 'Opening' },
      ],
    }),
    ended('t1', 'ok'),
    call('b1', 'Bash', { command: 'git status', description: 'Status' }),
    ended('b1', 'On branch fix-login'),
    call('e1', 'Edit', { file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' }),
    ended('e1', 'The file was updated'),
    row({
      kind: 'input',
      payload: { source: 'team', kind: 'direct', subject: 'ops', title: 'from ops', body: 'private plan', url: null },
    }),
    prompt('Also add a test'),
    prompt('ignored update turn', { auto: true }),
    say('Opened https://github.com/acme/app/pull/7. Should I also fix the logout redirect?'),
  ]
}

const source = (rows: MessageRow[], extra: Partial<BriefSource> = {}): BriefSource => ({
  title: 'Login fix',
  runtime: 'claude',
  model: null,
  role: 'Reviewer',
  cwd: '/work/app',
  pr_urls: ['https://github.com/acme/app/pull/7'],
  asking: false,
  rows,
  ...extra,
})

describe('the brief of an agent', () => {
  it('says what was asked, planned, done, changed and linked, and its last words', () => {
    const { text, cut } = buildBrief(source(claudeRows()))
    expect(cut).toBe(false)
    expect(text).toContain(
      '# Brief of the agent "Login fix"\nRuntime: claude\nRole: Reviewer\nWorking folder: /work/app',
    )
    expect(text).toContain('## Asked\nFix the login redirect')
    expect(text).toContain('Later:\n- Also add a test')
    expect(text).toContain('## Plan\n- [completed] Find the redirect\n- [in_progress] Open a PR')
    expect(text).toContain('Ran: git status.')
    expect(text).toContain('## Files changed\n- src/login.ts')
    expect(text).toContain('## Pull requests\n- https://github.com/acme/app/pull/7')
    expect(text).toContain('## Last words\nOpened https://github.com/acme/app/pull/7.')
    expect(text).not.toContain('ignored update turn')
  })

  it('never carries a credential or a direct message', () => {
    const { text } = buildBrief(source(claudeRows()))
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('private plan')
  })

  it('names an open question as one', () => {
    expect(buildBrief(source(claudeRows(), { asking: true })).text).toContain(
      '## Open question to the user\nOpened https://github.com/acme/app/pull/7. Should I',
    )
  })

  it('drops the oldest steps first to stay within its size', () => {
    const many = Array.from({ length: 40 }, (_, i) => [
      call(`s${String(i)}`, 'Bash', { command: `echo step-${String(i).padStart(2, '0')} ${'x'.repeat(100)}` }),
      ended(`s${String(i)}`, 'done'),
    ]).flat()
    const { text, cut } = buildBrief(source([prompt('Run the steps'), ...many]), 2500)
    expect(cut).toBe(true)
    expect(text.length).toBeLessThanOrEqual(2500)
    expect(text).toContain('step-39')
    expect(text).not.toContain('step-00')
  })

  it('cuts the text itself when even its fixed parts are too long', () => {
    const { text, cut } = buildBrief(source([prompt('y'.repeat(3000))]), 400)
    expect(cut).toBe(true)
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text.endsWith('[... cut]')).toBe(true)
  })

  it('reads a Codex transcript through the same neutral events', () => {
    const root = '01a20244-c954-7390-bda1-b0194900d368'
    const rows = (recorded as unknown[]).map((message) =>
      row({ kind: 'sdk', runtime: 'codex', payload: { root, message } satisfies CodexMessage }),
    )
    const { text } = buildBrief(source([prompt('Make the change'), ...rows], { runtime: 'codex', model: 'gpt-5.5' }))
    expect(text).toContain('Runtime: codex, model gpt-5.5')
    expect(text).toMatch(/## Done, newest last\n- Ran: /)
    expect(text).toContain('## Files changed\n- ')
  })
})

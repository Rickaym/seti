import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { promptText, sessionHistory, sessionPrs, sessionSpan } from './session-history.js'

let seq = 0

const entry = (type: SessionMessage['type'], message: unknown, timestamp?: string): SessionMessage => ({
  type,
  uuid: `u-${String(++seq)}`,
  session_id: 'source',
  message,
  parent_tool_use_id: null,
  parent_agent_id: null,
  ...(timestamp === undefined ? {} : { timestamp }),
})

const user = (content: unknown, timestamp?: string) => entry('user', { role: 'user', content }, timestamp)
const assistant = (content: unknown[], timestamp?: string) =>
  entry('assistant', { id: 'msg', role: 'assistant', model: 'claude', content, usage: {} }, timestamp)
const bash = (id: string, command: string) => assistant([{ type: 'tool_use', id, name: 'Bash', input: { command } }])
const result = (id: string, text: string) => user([{ type: 'tool_result', tool_use_id: id, content: text }])

const CREATED = 'https://github.com/acme/app/pull/12'
const MENTIONED = 'https://github.com/acme/other/pull/3'

describe('promptText', () => {
  it('keeps what the user typed and shows commands as typed', () => {
    expect(promptText('  Fix the login bug ')).toBe('Fix the login bug')
    expect(
      promptText(
        '<command-message>review is running</command-message>\n<command-name>/review</command-name>\n' +
          '<command-args>42</command-args>',
      ),
    ).toBe('/review 42')
    expect(promptText('<command-name>/clear</command-name><command-args></command-args>')).toBe('/clear')
    expect(promptText('<bash-input>git status</bash-input>')).toBe('! git status')
  })

  it('drops terminal bookkeeping', () => {
    expect(promptText('<local-command-stdout>ok</local-command-stdout>')).toBeNull()
    expect(promptText('<task-notification>done</task-notification>')).toBeNull()
    expect(promptText('<system-reminder>x</system-reminder>')).toBeNull()
    expect(promptText('   ')).toBeNull()
  })
})

describe('sessionHistory', () => {
  it('converts prompts, text, tool calls and results into stored transcript rows', () => {
    const rows = sessionHistory([
      user('Open a PR', '2026-09-20T10:00:00.000Z'),
      assistant([{ type: 'thinking', thinking: 'hmm', signature: 'sig' }]),
      assistant([
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'text', text: 'Opening it now.' },
      ]),
      bash('t1', 'gh pr create --fill'),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: CREATED },
        { type: 'text', text: 'ignored note' },
      ]),
      entry('system', undefined),
      user('<local-command-stdout>hidden</local-command-stdout>'),
      user([{ type: 'text', text: 'Look at this' }, { type: 'image' }], '2026-09-20T11:00:00.000Z'),
    ])

    expect(rows.map((row) => row.body.kind)).toEqual(['prompt', 'sdk', 'sdk', 'sdk', 'prompt'])
    expect(rows[0]).toEqual({
      body: { kind: 'prompt', payload: { text: 'Open a PR' } },
      at: '2026-09-20T10:00:00.000Z',
    })
    expect(rows[1]?.body).toMatchObject({
      kind: 'sdk',
      payload: {
        type: 'assistant',
        session_id: 'source',
        parent_tool_use_id: null,
        message: { model: 'claude', content: [{ type: 'text', text: 'Opening it now.' }] },
      },
    })
    expect(rows[3]?.body).toMatchObject({
      kind: 'sdk',
      payload: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    })
    expect(JSON.stringify(rows[3])).not.toContain('ignored note')
    expect(rows[4]).toEqual({
      body: { kind: 'prompt', payload: { text: 'Look at this\n[image]' } },
      at: '2026-09-20T11:00:00.000Z',
    })
    expect(rows[2]?.at).toBeNull()
  })

  it('skips messages it cannot read', () => {
    expect(sessionHistory([entry('user', { nope: true }), entry('assistant', 'text')])).toEqual([])
  })
})

describe('sessionPrs', () => {
  it('separates PRs created with gh pr create from other mentions', () => {
    const raw = [
      user(`Please review ${MENTIONED}`),
      bash('v', 'gh pr view 3'),
      result('v', MENTIONED),
      bash('c', 'gh pr create --base main'),
      result('c', `Creating pull request\n${CREATED}\n`),
      assistant([{ type: 'text', text: `Opened ${CREATED}` }]),
    ]
    expect(sessionPrs(raw, sessionHistory(raw))).toEqual({ created: [CREATED], mentioned: [MENTIONED] })
  })
})

describe('sessionSpan', () => {
  it('reports the first and last timestamps', () => {
    const raw = [user('a', '2026-09-20T10:00:00.000Z'), user('b'), user('c', '2026-09-21T09:00:00.000Z')]
    expect(sessionSpan(raw)).toEqual({ first: '2026-09-20T10:00:00.000Z', last: '2026-09-21T09:00:00.000Z' })
    expect(sessionSpan([user('x')])).toEqual({ first: null, last: null })
  })
})

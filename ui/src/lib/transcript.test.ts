import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { indexTranscript, rendersContent, turnReplies } from '@/lib/transcript'

let nextId = 0

const sdkRow = (type: string, payload: Record<string, unknown>): MessageRow => {
  nextId += 1
  const message = { type, session_id: 's', uuid: String(nextId), ...payload }
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'sdk',
    payload: message as unknown as SDKMessage,
  }
}

const system = (payload: Record<string, unknown>) => sdkRow('system', payload)

const result = (payload: Record<string, unknown>) =>
  sdkRow('result', { subtype: 'success', is_error: false, result: '', duration_ms: 0, ...payload })

const prompt = (payload: Record<string, unknown>): MessageRow => {
  nextId += 1
  return {
    id: nextId,
    task_id: 't',
    outward: [],
    created_at: '2026-10-02T10:00:00.000Z',
    kind: 'prompt',
    payload: { text: 'hi', ...payload },
  }
}

const failed = () => result({ subtype: 'error_during_execution', is_error: true })

const said = (content: Record<string, unknown>[], parent: string | null = null) =>
  sdkRow('assistant', { message: { role: 'assistant', content }, parent_tool_use_id: parent })

const text = (value: string) => ({ type: 'text', text: value })
const call = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: {} })

describe('turnReplies', () => {
  it('keeps the text after the last tool call, joining blocks that follow it', () => {
    const end = result({})
    const rows = [
      prompt({}),
      said([text('Let me look.'), call('a')]),
      said([text('Found it.')]),
      said([text('Agent aside')], 'a'),
      said([text(' '), text('Second part.')]),
      end,
    ]
    expect(turnReplies(rows).get(end.id)).toBe('Found it.\n\nSecond part.')
  })

  it('gives no reply to a turn that ended on a tool call or a prompt that started a new turn', () => {
    const stopped = failed()
    const done = result({})
    const rows = [prompt({}), said([text('Checking.'), call('b')]), stopped, said([text('Old')]), prompt({}), done]
    expect(turnReplies(rows).size).toBe(0)
  })

  it('skips a malformed row and keeps the reply around it', () => {
    const end = result({})
    const broken = (content: unknown) => sdkRow('assistant', { message: { content }, parent_tool_use_id: null })
    const rows = [prompt({}), said([text('Done.')]), broken(7), broken([{ type: 'text', text: 42 }, null]), end]
    expect(turnReplies(rows).get(end.id)).toBe('Done.')
  })
})

describe('indexTranscript background', () => {
  it('follows each background process from start to its last reported status', () => {
    const rows = [
      system({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'mon', description: 'watch' }),
      system({ subtype: 'task_started', task_id: 'b2', tool_use_id: 'shell', description: 'serve' }),
      system({ subtype: 'task_started', task_id: 'b3', tool_use_id: 'build', description: 'build' }),
      system({ subtype: 'task_updated', task_id: 'b2', patch: { status: 'killed' } }),
      system({ subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } }),
      system({ subtype: 'task_notification', task_id: 'b3', tool_use_id: 'build', status: 'failed', summary: '' }),
    ]
    expect(Object.fromEntries(indexTranscript(rows).background)).toEqual({
      mon: 'running',
      shell: 'killed',
      build: 'failed',
    })
  })
})

describe('rendersContent results', () => {
  it('leaves out a notification turn that took no step, and keeps every other result', () => {
    const notice = { kind: 'task-notification' }
    expect(rendersContent(result({ num_turns: 0, origin: notice }))).toBe(false)
    expect(rendersContent(result({ num_turns: 2, origin: notice }))).toBe(true)
    expect(rendersContent(result({ num_turns: 0, origin: notice, is_error: true, result: 'boom' }))).toBe(true)
    expect(rendersContent(result({ num_turns: 0 }))).toBe(true)
  })
})

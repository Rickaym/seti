import { checkMessageBody } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOutward, readPayload, readStoredBody, storedFields, storedJson } from './stored-rows.js'

const ROW = { task_id: 't', id: 1 }
const REPLACEMENT = String.fromCodePoint(0xfffd)
const SMILE = String.fromCodePoint(0x1f600)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkMessageBody', () => {
  it('passes messages a newer Claude Code may send, keeping every field', () => {
    for (const payload of [
      { type: 'stream_event', event: {} },
      { type: 'system', subtype: 'hook_response', output: 1 },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'server_tool_use', x: 1 }] } },
      { type: 'user', message: { content: 'plain text' }, isReplay: true },
    ]) {
      expect(checkMessageBody('sdk', payload)).toEqual({ ok: true, body: { kind: 'sdk', payload } })
    }
  })

  it('names the first field that does not fit, without its value', () => {
    const notes = [
      [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 5 }] } }, 'message.content.0.thinking'],
      [{ type: 'system', subtype: 'task_progress', task_id: 'x', description: 'd' }, 'usage'],
      [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 5 }] } }, 'content'],
      [{ type: 'result', subtype: 'success', is_error: false }, 'result'],
    ] as const
    for (const [payload, path] of notes) {
      const checked = checkMessageBody('sdk', payload)
      expect(checked.ok ? '' : checked.reason).toContain(path)
    }
    expect(checkMessageBody('__proto__', {})).toEqual({ ok: false, reason: 'unknown kind' })
    expect(checkMessageBody('sdk', { type: 'system', subtype: 'constructor' }).ok).toBe(true)
  })
})

describe('reading stored rows', () => {
  it('reads invalid JSON as unreadable and warns once, without the text', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const row = { task_id: 'bad-json', id: 7 }
    expect(readStoredBody(row, 'prompt', '{"text": "secret')).toEqual({
      kind: 'unreadable',
      payload: { kind: 'prompt', reason: 'invalid JSON' },
    })
    readStoredBody(row, 'prompt', '{"text": "secret')
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      msg: 'unreadable transcript row',
      task_id: 'bad-json',
      message_id: 7,
      kind: 'prompt',
      reason: 'invalid JSON',
    })
  })

  it('reads a payload only as the kind asked for', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(readPayload(ROW, 'seti', '{"error":"boom"}')).toEqual({ error: 'boom' })
    expect(readPayload({ ...ROW, id: 2 }, 'seti', '{"error":1}')).toBeNull()
  })

  it('reads outward actions and top-level fields leniently', () => {
    expect(readOutward('["gh pr create", 5]')).toEqual(['gh pr create'])
    expect(readOutward('{')).toEqual([])
    expect(storedFields('{"subtype":"task_progress"}')).toEqual({ subtype: 'task_progress' })
    expect([storedFields('null'), storedFields('[1]'), storedFields('{')]).toEqual([{}, {}, {}])
  })

  it('stores NUL and unpaired surrogates as U+FFFD and keeps pairs', () => {
    expect(JSON.parse(storedJson({ a: ['x\0y', '\uDC00', `smile ${SMILE}`] }))).toEqual({
      a: [`x${REPLACEMENT}y`, REPLACEMENT, `smile ${SMILE}`],
    })
  })
})

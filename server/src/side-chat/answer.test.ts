import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { fakeAssistant, fakeMessage } from '../fake-sdk.js'
import { AnswerStream, streamingText } from './answer.js'

const TOKEN = `ghp_${'Z9y8X7w6V5'.repeat(4).slice(0, 36)}`

const delta = (text: string, parent: string | null = null) =>
  fakeMessage('stream_event', {
    parent_tool_use_id: parent,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  }) as unknown as SDKMessage

const message = (m: unknown) => m as SDKMessage

describe('AnswerStream', () => {
  it('streams the answer so far, at most every 100 ms, and whole once a block ends', () => {
    const stream = new AnswerStream()
    expect(stream.next(delta('The fix '), 0)).toEqual({ type: 'text', text: 'The fix ' })
    expect(stream.next(delta('was the cache'), 50)).toBeNull()
    expect(stream.next(delta(' key.'), 150)).toEqual({ type: 'text', text: 'The fix was the cache ' })
    expect(stream.next(message(fakeAssistant('The fix was the cache key.')), 160)).toEqual({
      type: 'text',
      text: 'The fix was the cache key.',
    })
    expect(stream.text).toBe('The fix was the cache key.')
  })

  it('names the files it reads and skips subagent messages', () => {
    const stream = new AnswerStream()
    const read = fakeMessage('assistant', {
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/app.ts' } }] },
    })
    expect(stream.next(message(read), 0)).toEqual({ type: 'tool', text: 'Read src/app.ts' })
    expect(stream.next(delta('inside', 'toolu_sub'), 500)).toBeNull()
    expect(stream.next(message(fakeAssistant('sub', 'toolu_sub')), 600)).toBeNull()
  })

  it('never shows a key, even half written', () => {
    expect(streamingText(`Use ${TOKEN.slice(0, 20)}`)).toBe('Use ')
    expect(streamingText(`Use ${TOKEN} here`)).not.toContain(TOKEN)
  })
})

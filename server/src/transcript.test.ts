import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { WIRE_TEXT_LIMIT, wireRow } from './transcript.js'

const LONG = 'x'.repeat(1024 * 1024)

const sdkRow = (payload: unknown): MessageRow =>
  ({ id: 7, task_id: 'task', kind: 'sdk', payload, outward: [], created_at: '2026-01-01' }) as MessageRow

const toolResult = (content: unknown, extra: Record<string, unknown> = {}) =>
  sdkRow({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
    parent_tool_use_id: null,
    ...extra,
  })

function payloadOf(row: MessageRow): SDKMessage {
  if (row.kind !== 'sdk') {
    throw new Error('expected an sdk row')
  }
  return row.payload
}

function resultContent(row: MessageRow): unknown {
  const payload = payloadOf(row)
  if (payload.type !== 'user' || typeof payload.message.content === 'string') {
    throw new Error('expected a user message with blocks')
  }
  const [block] = payload.message.content
  return block?.type === 'tool_result' ? block.content : undefined
}

const image = (bytes: number) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) },
})

describe('wireRow', () => {
  it('leaves prompts and short tool results as they are', () => {
    const prompt: MessageRow = {
      id: 1,
      task_id: 'task',
      kind: 'prompt',
      payload: { text: LONG },
      outward: [],
      created_at: '2026-01-01',
    }
    expect(wireRow(prompt)).toBe(prompt)

    const wired = wireRow(toolResult('ok'))
    expect(resultContent(wired)).toBe('ok')
    expect(wired.trimmed).toBeUndefined()
  })

  it('cuts a long string result to its head and a marker with the original size', () => {
    const stored = toolResult(LONG)
    const wired = wireRow(stored)
    const content = resultContent(wired)
    expect(typeof content).toBe('string')
    expect(String(content).startsWith('x'.repeat(WIRE_TEXT_LIMIT))).toBe(true)
    expect(String(content)).toContain('[trimmed for display: first 16 KB of 1.0 MB shown]')
    expect(String(content).length).toBeLessThan(WIRE_TEXT_LIMIT + 100)
    expect(wired.trimmed).toEqual(['toolu_1'])
    expect(resultContent(stored)).toBe(LONG)
  })

  it('shares one budget across text blocks and keeps small non-text blocks that fit', () => {
    const small = image(2000)
    const wired = wireRow(
      toolResult([
        { type: 'text', text: 'a'.repeat(12_000) },
        small,
        { type: 'text', text: 'b'.repeat(12_000) },
        image(40_000),
        { type: 'text', text: 'c'.repeat(100) },
      ]),
    )
    const parts = resultContent(wired) as { type: string; text?: string }[]
    const smallSize = JSON.stringify(small).length
    expect(parts.map((part) => part.type)).toEqual(['text', 'image', 'text', 'text', 'text'])
    expect(parts[0]?.text).toBe('a'.repeat(12_000))
    expect(parts[1]).toEqual(small)
    expect(parts[2]?.text).toBe('b'.repeat(WIRE_TEXT_LIMIT - 12_000 - smallSize))
    expect(parts[3]?.text).toMatch(/^\[image block of \d+ KB omitted\]$/)
    expect(parts[4]?.text).toMatch(/^\[trimmed for display: first 16 KB of \d+ KB shown\]$/)
    expect(wired.trimmed).toEqual(['toolu_1'])
  })

  it('replaces a large non-text block with a note', () => {
    const parts = resultContent(wireRow(toolResult([image(3 * 1024 * 1024)]))) as { type: string; text: string }[]
    expect(parts).toEqual([
      { type: 'text', text: '[image block of 3.0 MB omitted]' },
      { type: 'text', text: '[trimmed for display: first 16 KB of 3.0 MB shown]' },
    ])
  })

  it('drops the structured tool output, which repeats the result text', () => {
    const wired = payloadOf(wireRow(toolResult('ok', { tool_use_result: { stdout: LONG } })))
    expect(wired.type === 'user' && 'tool_use_result' in wired).toBe(false)
  })

  it('cuts long strings in tool inputs and names the call', () => {
    const wired = wireRow(
      sdkRow({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: LONG, signature: 'S'.repeat(2000) },
            { type: 'text', text: 'Writing the file' },
            { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/repo/a.txt', content: LONG } },
            { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/repo/a.txt' } },
          ],
        },
        parent_tool_use_id: null,
      }),
    )
    const payload = payloadOf(wired)
    const blocks = payload.type === 'assistant' ? payload.message.content : []
    const thinking = blocks[0]?.type === 'thinking' ? blocks[0] : undefined
    expect(thinking?.signature).toBe('')
    expect(thinking?.thinking.length).toBeLessThan(WIRE_TEXT_LIMIT + 100)
    expect(blocks[1]).toEqual({ type: 'text', text: 'Writing the file' })
    const input = blocks[2]?.type === 'tool_use' ? (blocks[2].input as Record<string, string>) : {}
    expect(input.file_path).toBe('/repo/a.txt')
    expect(input.content?.length).toBeLessThan(WIRE_TEXT_LIMIT + 100)
    expect(blocks[3]?.type === 'tool_use' && blocks[3].input).toEqual({ file_path: '/repo/a.txt' })
    expect(wired.trimmed).toEqual(['toolu_w'])
  })

  it('cuts long shell output per stream and names the streams it cut', () => {
    const shellRow = (stdout: string, stderr: string): MessageRow => ({
      id: 9,
      task_id: 'task',
      kind: 'shell',
      payload: {
        run_id: 'run',
        command: 'make',
        cwd: '/repo',
        started_at: '2026-01-01T00:00:00.000Z',
        exit_code: 0,
        signal: null,
        ended_by: null,
        duration_ms: 5,
        stdout,
        stderr,
      },
      outward: [],
      created_at: '2026-01-01',
    })
    const short = shellRow('ok', '')
    expect(wireRow(short)).toBe(short)
    const wired = wireRow(shellRow('ok', LONG))
    expect(wired.trimmed).toEqual(['stderr'])
    const payload = wired.kind === 'shell' ? wired.payload : null
    expect(payload?.stdout).toBe('ok')
    expect(payload?.stderr.length).toBeLessThan(WIRE_TEXT_LIMIT + 100)
    expect(payload?.stderr).toContain('[trimmed for display: first 16 KB of 1.0 MB shown]')
  })

  it('drops command and skill lists from init messages but keeps what the transcript shows', () => {
    const payload = payloadOf(
      wireRow(
        sdkRow({
          type: 'system',
          subtype: 'init',
          session_id: 'session',
          model: 'claude',
          permissionMode: 'bypassPermissions',
          cwd: '/tmp',
          mcp_servers: [{ name: 'one', status: 'connected' }],
          slash_commands: ['a', 'b'],
          skills: ['c'],
        }),
      ),
    )
    expect(payload).toMatchObject({ session_id: 'session', slash_commands: [], skills: [] })
    expect(payload.type === 'system' && payload.subtype === 'init' && payload.mcp_servers).toHaveLength(1)
  })
})

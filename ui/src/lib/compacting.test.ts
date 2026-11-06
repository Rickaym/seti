import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow, PromptPayload } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { compactFailure, compactingSince } from '@/lib/compacting'
import { rendersContent } from '@/lib/transcript'

let nextId = 0

const at = (second: number) => new Date(Date.UTC(2026, 8, 28, 7, 0, second)).toISOString()

function row(second: number, body: Pick<MessageRow, 'kind' | 'payload'>): MessageRow {
  nextId += 1
  return { id: nextId, task_id: 't', outward: [], created_at: at(second), ...body } as MessageRow
}

const prompt = (second: number, payload: PromptPayload) => row(second, { kind: 'prompt', payload })

const sdk = (second: number, payload: Record<string, unknown>) =>
  row(second, { kind: 'sdk', payload: { session_id: 's', uuid: 'u', ...payload } as unknown as SDKMessage })

const status = (second: number, value: 'compacting' | 'requesting' | null, extra: Record<string, unknown> = {}) =>
  sdk(second, { type: 'system', subtype: 'status', status: value, ...extra })

const boundary = (second: number) =>
  sdk(second, {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 16_000 },
  })

const assistant = (second: number) =>
  sdk(second, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }] } })

const result = (second: number) => sdk(second, { type: 'result', subtype: 'success', is_error: false })

describe('compactingSince', () => {
  it('starts at the /compact prompt before any status arrives', () => {
    expect(compactingSince([assistant(0), result(1), prompt(2, { text: '/compact keep the plan' })], true)).toBe(at(2))
  })

  it('keeps the /compact start through repeated compacting statuses', () => {
    const rows = [prompt(0, { text: '/compact' }), status(60, 'compacting'), status(90, 'compacting')]
    expect(compactingSince(rows, true)).toBe(at(0))
  })

  it('starts auto compaction at its first compacting status', () => {
    const rows = [
      prompt(0, { text: 'Refactor the auth module.' }),
      assistant(5),
      status(10, 'compacting'),
      assistant(20),
      status(40, 'compacting'),
    ]
    expect(compactingSince(rows, true)).toBe(at(10))
  })

  it('ignores messages queued while it compacts', () => {
    const rows = [
      prompt(0, { text: '/compact' }),
      status(30, 'compacting'),
      prompt(45, { text: 'and then the docs', queued: 'delivered' }),
    ]
    expect(compactingSince(rows, true)).toBe(at(0))
  })

  it('ends at the compact boundary', () => {
    const rows = [prompt(0, { text: '/compact' }), status(30, 'compacting'), boundary(90)]
    expect(compactingSince(rows, true)).toBeNull()
  })

  it.each([null, 'requesting'] as const)('ends when the status clears to %s', (value) => {
    const rows = [prompt(0, { text: '/compact' }), status(30, 'compacting'), status(90, value)]
    expect(compactingSince(rows, true)).toBeNull()
  })

  it('ends with the turn, by its result or by the task leaving running', () => {
    const rows = [prompt(0, { text: '/compact' }), status(30, 'compacting')]
    expect(compactingSince([...rows, result(40)], true)).toBeNull()
    expect(compactingSince(rows, false)).toBeNull()
    expect(compactingSince([...rows, row(40, { kind: 'seti', payload: { error: 'process exited' } })], true)).toBeNull()
  })

  it('does not reach past a boundary into an earlier compaction', () => {
    const rows = [
      prompt(0, { text: '/compact' }),
      status(30, 'compacting'),
      boundary(40),
      result(41),
      prompt(50, { text: 'Carry on.' }),
      assistant(55),
    ]
    expect(compactingSince(rows, true)).toBeNull()
  })

  it('is null for a running turn that never compacts', () => {
    expect(compactingSince([prompt(0, { text: 'Refactor.' }), assistant(1)], true)).toBeNull()
    expect(compactingSince([], true)).toBeNull()
  })
})

describe('compactFailure', () => {
  it('reports a failed compaction and shows it in the transcript', () => {
    const failed = status(90, null, { compact_result: 'failed', compact_error: 'prompt too long' })
    expect(compactFailure(failed)).toBe('prompt too long')
    expect(rendersContent(failed)).toBe(true)
  })

  it('leaves compacting and successful statuses out of the transcript', () => {
    for (const quiet of [status(30, 'compacting'), status(90, null, { compact_result: 'success' })]) {
      expect(compactFailure(quiet)).toBeNull()
      expect(rendersContent(quiet)).toBe(false)
    }
  })
})

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { interruptedResultIds } from '@/lib/interruptions'

let nextId = 0

const row = (kind: 'sdk' | 'prompt', payload: Record<string, unknown>): MessageRow => {
  nextId += 1
  const base = { id: nextId, task_id: 't', outward: [], created_at: '2026-10-02T10:00:00.000Z' }
  return kind === 'sdk'
    ? { ...base, kind, payload: { session_id: 's', uuid: String(nextId), ...payload } as unknown as SDKMessage }
    : { ...base, kind, payload: { text: 'hi', ...payload } }
}

const prompt = (payload: Record<string, unknown> = {}) => row('prompt', payload)
const marker = () =>
  row('sdk', {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })
const said = (parent: string | null = null) =>
  row('sdk', { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: parent })
const result = (isError: boolean) =>
  row('sdk', {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: '',
    duration_ms: 0,
  })

const outcome = (rows: readonly MessageRow[], end: MessageRow, running = false) =>
  interruptedResultIds(rows, running).get(end.id)

describe('interruptedResultIds', () => {
  it('reads a stop that hands over a queued message as replaced, from waiting to the next turn', () => {
    const cut = result(true)
    const waiting = [prompt(), said(), prompt({ queued: 'waiting' }), marker(), cut]
    expect(outcome(waiting, cut)).toBe('replaced')
    const taken = [prompt(), said(), prompt({ queued: 'delivered' }), marker(), cut]
    expect(outcome(taken, cut, true)).toBe('replaced')
    expect(outcome([...taken, said(), result(false)], cut)).toBe('replaced')
  })

  it('reads a turn a later interrupting message cut short as replaced', () => {
    const cut = result(true)
    expect(outcome([prompt(), marker(), cut, prompt({ interrupted: true })], cut)).toBe('replaced')
  })

  it('reads a stop with nothing queued to follow as stopped', () => {
    const cut = result(true)
    expect(outcome([prompt(), said(), marker(), cut], cut)).toBe('stopped')
    expect(outcome([prompt(), prompt({ queued: 'removed' }), marker(), cut], cut)).toBe('stopped')
  })

  it('reads a stop after a queued message joined the turn as stopped once the agent is idle', () => {
    const cut = result(true)
    const folded = [prompt(), prompt({ queued: 'delivered' }), said(), marker(), cut]
    expect(outcome(folded, cut)).toBe('stopped')
    expect(outcome([...folded, said('agent-call')], cut)).toBe('stopped')
    expect(outcome([...folded, prompt(), said(), result(false)], cut)).toBe('stopped')
  })

  it('leaves turns that end on their own alone', () => {
    expect(interruptedResultIds([prompt(), said(), result(false)], false).size).toBe(0)
    expect(interruptedResultIds([prompt(), result(true)], false).size).toBe(0)
    expect(interruptedResultIds([prompt(), prompt({ queued: 'delivered' }), result(false)], true).size).toBe(0)
  })
})

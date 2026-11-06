import { SHELL_CONTEXT_RUNS, type MessageRow, type PromptPayload } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { shellDeliveries } from '@/lib/transcript'

const AT = '2026-10-01T10:00:00.000Z'

const shell = (id: number): MessageRow => ({
  id,
  task_id: 't',
  outward: [],
  created_at: AT,
  kind: 'shell',
  payload: {
    run_id: `run-${String(id)}`,
    command: 'echo hi',
    cwd: '/work',
    started_at: AT,
    exit_code: 0,
    signal: null,
    ended_by: null,
    duration_ms: 5,
    stdout: 'hi\n',
    stderr: '',
  },
})

const prompt = (id: number, payload: PromptPayload): MessageRow => ({
  id,
  task_id: 't',
  outward: [],
  created_at: AT,
  kind: 'prompt',
  payload,
})

const deliveries = (rows: readonly MessageRow[]) => Object.fromEntries(shellDeliveries(rows))

// Mirrors shellRuns.sinceLastTurn in server/src/store/shell.ts, which shellPreface sends.
describe('shellDeliveries', () => {
  it('marks runs after the last prompt the agent read as going with the next message', () => {
    expect(deliveries([shell(1), shell(2)])).toEqual({ 1: 'next', 2: 'next' })
  })

  it('drops the note once a later message carried the runs, auto turns included', () => {
    expect(deliveries([shell(1), prompt(2, { text: 'go on' }), shell(3)])).toEqual({ 3: 'next' })
    expect(deliveries([shell(1), prompt(2, { text: '', auto: true })])).toEqual({})
    expect(deliveries([shell(1), prompt(2, { text: 'later', queued: 'waiting' })])).toEqual({})
  })

  it('keeps runs pending past a slash command or a message taken back from the queue', () => {
    const rows = [shell(1), prompt(2, { text: '/compact' }), prompt(3, { text: 'x', queued: 'removed' }), shell(4)]
    expect(deliveries(rows)).toEqual({ 1: 'next', 4: 'next' })
  })

  it('sends only the newest runs up to the limit and says the older ones will not go', () => {
    const rows = Array.from({ length: SHELL_CONTEXT_RUNS + 2 }, (_, index) => shell(index + 1))
    const marks = shellDeliveries(rows)
    expect(SHELL_CONTEXT_RUNS).toBe(10)
    expect([marks.get(1), marks.get(2), marks.get(3)]).toEqual(['dropped', 'dropped', 'next'])
    expect([...marks.values()].filter((mark) => mark === 'next')).toHaveLength(SHELL_CONTEXT_RUNS)
  })
})
